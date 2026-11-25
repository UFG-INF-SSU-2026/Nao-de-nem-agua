'use strict';
/*
 * Marco 4 -- persistencia do servico-irrigacao (TimescaleDB).
 *
 * Tres responsabilidades:
 *
 *   1. HISTORICO   gravar(tabela, linha): telemetria, comandos, acks, alertas e
 *                  transicoes vao para hypertables (persistencia/schema.sql).
 *   2. ESTADO      salvarEstado / carregarEstado: snapshot das regras (doses na
 *                  janela, bloqueios, deduplicacao, contadores), restaurado na
 *                  partida -- e o que resolve a limitacao 6 do marco-04.md.
 *   3. CADASTRO    carregarCadastro: vaso, especie e grupo, de onde sai o perfil
 *                  de cuidado (persistencia/perfil.js).
 *
 * O BANCO NAO E CAMINHO CRITICO DA DECISAO. gravar() nunca bloqueia nem lanca:
 * enfileira em memoria e um despejo assincrono escreve. Com o banco fora do ar,
 * o servico continua medindo, decidindo e comandando; a fila cresce ate filaMax
 * (depois descarta as MAIS ANTIGAS, contando quantas) e e despejada na volta,
 * com espera exponencial entre tentativas. E o mesmo "silencio nao e
 * normalidade" do Marco 3, aplicado ao armazenamento: a queda e registrada, a
 * recuperacao tambem.
 *
 * Erro de CONEXAO (banco caiu) mantem a linha na fila. Erro de DADO (SQLSTATE
 * de restricao, tipo...) descarta so aquela linha -- uma linha ruim nao pode
 * travar a fila para sempre.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { randomUUID } = require('crypto');

const RAIZ = path.resolve(__dirname, '..');
const SCHEMA = 'naodenemagua';

const TABELAS = new Set([
  'telemetria_solo', 'telemetria_ambiente', 'telemetria_reservatorio', 'telemetria_luz',
  'comandos', 'confirmacoes', 'alertas', 'transicoes'
]);
const TABELAS_COM_RETENCAO = ['telemetria_solo', 'telemetria_ambiente', 'telemetria_reservatorio', 'telemetria_luz'];

/* Senha do papel do servico: variavel de ambiente ou o .env gerado por `npm run seguranca`. */
function senhaDoServico() {
  if (process.env.PERSISTENCIA_SENHA_SERVICO) return process.env.PERSISTENCIA_SENHA_SERVICO;
  const arquivo = path.join(RAIZ, '.env');
  if (!fs.existsSync(arquivo)) return null;
  return util.parseEnv(fs.readFileSync(arquivo, 'utf8')).PERSISTENCIA_SENHA_SERVICO || null;
}

/* Comandos do schema.sql, um por um (agregado continuo nao roda em transacao). */
function comandosSql(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return texto.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/* Erro de conexao/indisponibilidade (re-tentar) x erro de dado (descartar a linha). */
function erroDeConexao(e) {
  const c = e && e.code;
  if (typeof c !== 'string' || !/^[0-9A-Z]{5}$/.test(c)) return true; // ECONNREFUSED, timeout, socket...
  return c.startsWith('08') || c.startsWith('57') || c.startsWith('53') || c === '3D000' || c === '28P01';
}

class Persistencia {
  /*
   * opcoes.log       Log do servico (opcional)
   * opcoes.executor  async (sql, params) -> { rows } -- injetavel nos testes
   * opcoes.migrar    async () -> void           -- injetavel nos testes
   */
  constructor(cfg, opcoes) {
    const o = opcoes || {};
    this.cfg = cfg;
    this.p = cfg.persistencia || {};
    this.vasoId = cfg.identidade.vasoId;
    this.log = o.log || null;
    this.executor = o.executor || null;
    this.migrarFn = o.migrar || null;
    this.pool = null;

    this.fila = [];
    this.estadosPendentes = new Map();
    this.conectado = false;
    this.migrado = false;
    this.despejando = false;
    this.timer = null;
    this.esperaMs = 1000;
    this.gravadas = 0;
    this.descartadas = 0;
    this.rejeitadas = 0;
    this.quedas = 0;
    this.encerrando = false;
  }

  get habilitada() {
    return Boolean(Number(this.p.habilitada));
  }

  registrar(msg, dados) {
    if (this.log) this.log.registrar('PERSISTENCIA', msg, dados);
  }

  // -------------------------------------------------------------------------
  // Conexao e migracao
  // -------------------------------------------------------------------------

  criarPool() {
    if (this.executor || this.pool) return;
    const { Pool } = require('pg');
    this.pool = new Pool({
      host: this.p.host,
      port: Number(this.p.porta),
      database: this.p.banco,
      user: this.p.usuario,
      password: senhaDoServico() || undefined,
      max: 4,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      options: `-c search_path=${SCHEMA},public`
    });
    // Sem este handler, um cliente ocioso que perde a conexao (banco reiniciou)
    // derrubaria o processo inteiro com 'error' nao tratado.
    this.pool.on('error', (e) => this.marcarQueda(e));
    this.executor = (sql, params) => this.pool.query(sql, params);
  }

  async migrar() {
    if (this.migrarFn) {
      await this.migrarFn();
    } else {
      const cliente = await this.pool.connect();
      try {
        for (const sql of comandosSql(path.join(__dirname, 'schema.sql'))) await cliente.query(sql);
        for (const tabela of TABELAS_COM_RETENCAO) {
          await cliente.query(
            'SELECT add_retention_policy($1::regclass, make_interval(days => $2::int), if_not_exists => TRUE)',
            [tabela, Number(this.p.retencaoDias) || 30]
          );
        }
      } finally {
        cliente.release();
      }
    }
    this.migrado = true;
  }

  /*
   * Na partida: tenta conectar e migrar por ate esperaPartidaMs (o conteiner
   * pode estar subindo). Sem sucesso, o servico segue em memoria e o despejo
   * continua tentando em segundo plano. Devolve true se conectou.
   */
  async iniciar() {
    if (!this.habilitada) {
      this.registrar('desabilitada (PERSISTENCIA_HABILITADA=0): estado e historico so em memoria');
      return false;
    }
    if (!this.executor && !senhaDoServico()) {
      this.registrar('sem PERSISTENCIA_SENHA_SERVICO (rode `npm run seguranca`): seguindo sem banco');
    }
    this.criarPool();
    const limite = Date.now() + (Number(this.p.esperaPartidaMs) || 0);
    let ultimoErro = null;
    do {
      try {
        await this.migrar();
        this.conectado = true;
        this.registrar(`conectado a ${this.p.host}:${this.p.porta}/${this.p.banco} como ${this.p.usuario} (schema migrado)`);
        return true;
      } catch (e) {
        ultimoErro = e;
        if (!erroDeConexao(e)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } while (Date.now() < limite);
    this.registrar(`banco indisponivel na partida (${ultimoErro && ultimoErro.message}): seguindo em memoria, tentando reconectar`, { codigo: ultimoErro && ultimoErro.code });
    this.quedas += 1;
    this.agendar(this.esperaMs);
    return false;
  }

  marcarQueda(e) {
    if (this.conectado) {
      this.quedas += 1;
      this.registrar(`banco indisponivel (${e && e.message}): gravacoes ficam na fila (${this.fila.length})`);
    }
    this.conectado = false;
  }

  // -------------------------------------------------------------------------
  // Historico
  // -------------------------------------------------------------------------

  /*
   * Enfileira uma linha. id e ts nascem AQUI: ts e o instante em que o servico
   * aceitou o dado (nao o do despejo), e o id torna o reenvio idempotente.
   */
  gravar(tabela, linha) {
    if (!this.habilitada) return;
    if (!TABELAS.has(tabela)) throw new Error(`tabela desconhecida: ${tabela}`);
    this.fila.push({ tabela, linha: { id: randomUUID(), ts: new Date(), vaso_id: this.vasoId, ...linha } });
    const max = Number(this.p.filaMax) || 10000;
    if (this.fila.length > max) {
      const excesso = this.fila.length - max;
      this.fila.splice(0, excesso);
      if (this.descartadas === 0 || this.descartadas % 1000 === 0) {
        this.registrar(`fila cheia (${max}): descartando as gravacoes mais antigas`);
      }
      this.descartadas += excesso;
    }
    this.agendar(this.conectado ? 0 : this.esperaMs);
  }

  salvarEstado(chave, valor) {
    if (!this.habilitada) return;
    this.estadosPendentes.set(chave, valor);
    this.agendar(this.conectado ? 0 : this.esperaMs);
  }

  agendar(ms) {
    if (this.timer || this.encerrando) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.despejar();
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  async despejar() {
    if (this.despejando || !this.habilitada) return;
    this.despejando = true;
    const estavaFora = !this.conectado;
    const naFila = this.fila.length;
    try {
      if (!this.migrado) await this.migrar();
      while (this.fila.length > 0) {
        const item = this.fila[0];
        try {
          await this.inserir(item.tabela, item.linha);
          this.gravadas += 1;
        } catch (e) {
          if (erroDeConexao(e)) throw e;
          this.rejeitadas += 1;
          this.registrar(`linha descartada em ${item.tabela}: ${e.message}`, { codigo: e.code });
        }
        this.fila.shift();
      }
      for (const [chave, valor] of [...this.estadosPendentes]) {
        await this.executor(
          'INSERT INTO estado_servico (chave, valor, atualizado_em) VALUES ($1, $2, now()) ' +
            'ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()',
          [chave, JSON.stringify(valor)]
        );
        // So remove se nao chegou um snapshot mais novo durante a escrita.
        if (this.estadosPendentes.get(chave) === valor) this.estadosPendentes.delete(chave);
      }
      this.conectado = true;
      this.esperaMs = 1000;
      if (estavaFora) {
        this.registrar(`banco de volta: ${naFila} gravacoes pendentes despejadas` +
          (this.descartadas ? ` (${this.descartadas} descartadas por fila cheia)` : ''));
      }
    } catch (e) {
      this.marcarQueda(e);
      this.agendar(this.esperaMs);
      this.esperaMs = Math.min(this.esperaMs * 2, 10000);
    } finally {
      this.despejando = false;
    }
    if (this.conectado && (this.fila.length > 0 || this.estadosPendentes.size > 0)) this.agendar(0);
  }

  async inserir(tabela, linha) {
    const colunas = Object.keys(linha);
    const valores = colunas.map((c) => {
      const v = linha[c];
      return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
    });
    const marcadores = colunas.map((_, i) => `$${i + 1}`).join(', ');
    await this.executor(
      `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcadores}) ON CONFLICT DO NOTHING`,
      valores
    );
  }

  // -------------------------------------------------------------------------
  // Leitura (partida e recarga do perfil)
  // -------------------------------------------------------------------------

  async carregarEstado(chave) {
    if (!this.habilitada || !this.conectado) return null;
    const r = await this.executor('SELECT valor, atualizado_em FROM estado_servico WHERE chave = $1', [chave]);
    if (r.rows.length === 0) return null;
    return { valor: r.rows[0].valor, atualizadoEm: r.rows[0].atualizado_em };
  }

  /* Vaso + especie + grupo numa linha, ou null se o vaso nao esta cadastrado. */
  async carregarCadastro(vasoId) {
    if (!this.habilitada || !this.conectado) return null;
    const r = await this.executor(
      `SELECT v.vaso_id, v.nome, v.ativo, v.device_id, v.localizacao, v.parametros AS vaso_parametros,
              e.id AS especie_id, e.nome_popular AS especie_nome, e.parametros AS especie_parametros,
              g.id AS grupo_id, g.nome AS grupo_nome, g.parametros AS grupo_parametros
         FROM vasos v
         LEFT JOIN especies e ON e.id = v.especie_id
         LEFT JOIN grupos g ON g.id = v.grupo_id
        WHERE v.vaso_id = $1`,
      [vasoId]
    );
    return r.rows[0] || null;
  }

  status() {
    return {
      habilitada: this.habilitada,
      conectado: this.conectado,
      fila: this.fila.length,
      gravadas: this.gravadas,
      descartadasFilaCheia: this.descartadas,
      rejeitadas: this.rejeitadas,
      quedas: this.quedas
    };
  }

  /* Despeja o que der em ate `ms` e fecha o pool. */
  async fechar(ms) {
    if (!this.habilitada) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.conectado) {
      await Promise.race([this.despejar(), new Promise((r) => setTimeout(r, ms || 1500))]);
    }
    this.encerrando = true;
    if (this.pool) await this.pool.end().catch(() => {});
  }
}

module.exports = { Persistencia, comandosSql, senhaDoServico, erroDeConexao, TABELAS, SCHEMA };

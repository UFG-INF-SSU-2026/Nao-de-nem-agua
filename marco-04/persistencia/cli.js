'use strict';
/*
 * Operacao do banco pelo papel do servico (nunca pelo administrador):
 *
 *   npm run banco:migrar               cria/atualiza o schema (o servico tambem faz isso ao subir)
 *   npm run banco:seed                 migra e grava o cadastro inicial (persistencia/seed.sql)
 *   npm run banco:consultar            resumo: cadastro, perfil efetivo, contagens, ultimas linhas, snapshot
 *   npm run banco:consultar -- --especie samambaia
 *                                      troca a especie do vaso (o servico aplica na proxima recarga)
 *
 * PERSISTENCIA_BANCO=naodenemagua_teste aponta para o banco de teste.
 */

const path = require('path');
const contrato = require('../contrato');
const { Persistencia, comandosSql } = require('./index');
const perfil = require('./perfil');

async function main() {
  const acao = process.argv[2];
  const cfg = contrato.carregarConfig();
  cfg.persistencia.habilitada = 1;
  const p = new Persistencia(cfg);
  p.p.esperaPartidaMs = 1000;
  const ok = await p.iniciar();
  if (!ok) {
    console.error('Banco indisponivel. Suba com `npm run banco` (e gere o .env com `npm run seguranca`).');
    process.exitCode = 1;
    return p.fechar();
  }

  if (acao === 'migrar') {
    console.log(`schema ${p.p.banco}.naodenemagua migrado`);
  } else if (acao === 'seed') {
    for (const sql of comandosSql(path.join(__dirname, 'seed.sql'))) await p.executor(sql);
    console.log('cadastro inicial gravado (especies, grupos, vaso-01)');
  } else if (acao === 'consultar') {
    await consultar(p, cfg);
  } else {
    console.log('uso: node persistencia/cli.js migrar|seed|consultar [--especie <id>] [--grupo <id>]');
  }
  await p.fechar();
}

async function consultar(p, cfg) {
  const q = async (sql, params) => (await p.executor(sql, params)).rows;
  const vasoId = cfg.identidade.vasoId;
  const arg = (nome) => {
    const i = process.argv.indexOf(nome);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  if (arg('--especie') || arg('--grupo')) {
    const campo = arg('--especie') ? 'especie_id' : 'grupo_id';
    const valor = arg('--especie') || arg('--grupo');
    await q(`UPDATE vasos SET ${campo} = $1, atualizado_em = now() WHERE vaso_id = $2`, [valor, vasoId]);
    console.log(`${vasoId}: ${campo} = ${valor} (o servico aplica na proxima recarga do perfil)`);
  }

  const cad = await p.carregarCadastro(vasoId);
  console.log('\n== cadastro');
  console.log(cad ? `${cad.vaso_id} "${cad.nome}" especie=${cad.especie_id} grupo=${cad.grupo_id || '-'}` : `${vasoId} nao cadastrado (npm run banco:seed)`);
  const r = perfil.resolverPerfil(perfil.capturarPadrao(cfg), perfil.camadasDoCadastro(cad), cfg.sobrescritasAmbiente);
  console.log('\n== perfil efetivo');
  for (const [chave, { valor, origem }] of Object.entries(r.valores)) console.log(`  ${chave.padEnd(26)} ${String(valor).padEnd(8)} (${origem})`);
  if (!r.ok) console.log(`  PERFIL INCOERENTE: ${r.erro}`);

  console.log('\n== linhas por tabela');
  for (const t of ['telemetria_solo', 'telemetria_ambiente', 'telemetria_reservatorio', 'telemetria_luz', 'comandos', 'confirmacoes', 'alertas', 'transicoes']) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(24)} ${n}`);
  }

  console.log('\n== solo por minuto (agregado continuo solo_1min, ultimos 5)');
  for (const l of await q('SELECT bucket, round(umidade_media::numeric,1) AS umid, round(ec25_media::numeric) AS ec, amostras FROM solo_1min WHERE vaso_id=$1 ORDER BY bucket DESC LIMIT 5', [vasoId])) {
    console.log(`  ${l.bucket.toISOString()} umidade=${l.umid}% ec25=${l.ec ?? '-'} amostras=${l.amostras}`);
  }

  console.log('\n== ultimos alertas');
  for (const l of await q('SELECT ts, tipo, severidade FROM alertas WHERE vaso_id=$1 ORDER BY ts DESC LIMIT 5', [vasoId])) {
    console.log(`  ${l.ts.toISOString()} ${l.severidade} ${l.tipo}`);
  }

  console.log('\n== ultimos comandos e confirmacoes');
  for (const l of await q(
    `SELECT c.ts, c.command_id, c.atuador, c.acao, c.motivo, a.resultado
       FROM comandos c LEFT JOIN confirmacoes a ON a.command_id = c.command_id AND a.ts >= c.ts
      WHERE c.vaso_id=$1 ORDER BY c.ts DESC LIMIT 5`, [vasoId])) {
    console.log(`  ${l.ts.toISOString()} ${l.command_id} ${l.atuador} ${l.acao} (${l.motivo}) -> ${l.resultado || 'sem ack'}`);
  }

  const est = await p.carregarEstado(`vaso:${vasoId}`);
  console.log('\n== snapshot do estado das regras');
  if (!est) console.log('  (nenhum)');
  else {
    const v = est.valor;
    console.log(`  salvo em ${new Date(est.atualizadoEm).toISOString()}`);
    console.log(`  doses na janela: ${(v.adubacao?.doses || []).length}, adubacao: ${v.adubacao?.estado}, ` +
      `irrigacao bloqueada: ${v.verificacao?.bloqueadaDesde ? 'sim (' + v.verificacao.diagnostico + ')' : 'nao'}, ` +
      `eventIds para deduplicacao: ${(v.solo?.eventIds || []).length}, contadores: cmd=${v.contadores?.cmd} atu=${v.contadores?.atu}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});


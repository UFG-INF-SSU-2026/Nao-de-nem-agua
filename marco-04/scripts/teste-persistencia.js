'use strict';
/*
 * Teste de integracao da PERSISTENCIA -- `npm run teste:persistencia`.
 *
 * Requer o banco no ar (`npm run banco`) e usa o banco SEPARADO
 * naodenemagua_teste (os dados dele sao apagados no inicio). Sobe broker e
 * servico reais, faz o papel do dispositivo e verifica, no banco e no log:
 *
 *   1. gravacao       telemetria, comando, ack, alerta e transicao nas
 *                     hypertables; eventId duplicado nao vira segunda linha
 *   2. preservacao    dose aplicada + irrigacao bloqueada -> SIGKILL no servico
 *                     -> servico sobe de novo e RESTAURA: limite de doses e
 *                     bloqueio continuam valendo, dedup continua valendo
 *   3. falha do banco `docker compose stop` -> servico segue decidindo e
 *                     enfileira -> `start` -> fila despejada, nada perdido
 *   4. reinicio do conteiner: o que foi gravado antes continua la (volume)
 *   5. perfil         trocar a especie do vaso muda o limiar sem reiniciar;
 *                     parametro do vaso vence o da especie
 *   6. menor privilegio: leitor_app le, mas nao grava
 *
 * --sem-queda-banco pula o cenario 3/4 (nao para o conteiner).
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const util = require('util');
const contrato = require('../contrato');
const seguranca = require('../seguranca');
const { Persistencia, comandosSql } = require('../persistencia');

const RAIZ = path.resolve(__dirname, '..');
const BANCO = 'naodenemagua_teste';
const SEM_QUEDA = process.argv.includes('--sem-queda-banco');

const AMBIENTE = {
  ...process.env,
  TOPIC_PREFIX: 'naodenemagua/v1',
  VASO_ID: 'vaso-01',
  EXIGIR_ASSINATURA: '1',
  VALIDADE_MS: '2500',
  COOLDOWN_MS: '1200',
  COMANDO_TTL_MS: '2000',
  AMOSTRAS_DEBOUNCE: '3',
  // LIMIAR_LIGA/LIMIAR_DESLIGA NAO sao definidos: variavel de ambiente vence o
  // perfil, e o cenario 5 precisa que o perfil do cadastro valha.
  VERIFICACAO_JANELA_MS: '3000',
  VERIFICACAO_BLOQUEIO_MS: '600000',
  ADUBACAO_ABSORCAO_MS: '1500',
  ADUBACAO_COOLDOWN_TENTATIVA_MS: '2000',
  ADUBACAO_TIMEOUT_MEDICAO_MS: '10000',
  ADUBACAO_JANELA_VERIFICACAO_MS: '600000', // a dose fica em VERIFICANDO ate o SIGKILL
  ADUBACAO_JANELA_DOSES_MS: '600000',
  ADUBACAO_PULSO_MS: '1000',
  PERSISTENCIA_HABILITADA: '1',
  PERSISTENCIA_BANCO: BANCO,
  PERSISTENCIA_INTERVALO_SNAPSHOT_MS: '300',
  PERSISTENCIA_INTERVALO_PERFIL_MS: '1000',
  PERSISTENCIA_ESPERA_PARTIDA_MS: '5000'
};
for (const k of ['LIMIAR_LIGA', 'LIMIAR_DESLIGA', 'DURACAO_PULSO_MS']) delete AMBIENTE[k];

const DEVICE_ID = 'sim-vaso-01';
const CHAVE = seguranca.dispositivo(DEVICE_ID).chave;
const BOOT_ID = crypto.randomBytes(3).toString('hex');
const PREFIXO = 'naodenemagua/v1/vaso/vaso-01';
const T = {
  solo: `${PREFIXO}/telemetry/soil`,
  nivel: `${PREFIXO}/telemetry/reservoir`,
  comando: `${PREFIXO}/command/irrigacao`,
  ack: `${PREFIXO}/ack/irrigacao`,
  atuador: `${PREFIXO}/command/atuador`,
  ackAtuador: `${PREFIXO}/ack/atuador`
};

const falhas = [];
let aprovados = 0;
let processos = [];
const semCor = (t) => t.replace(/\u001b\[[0-9;]*m/g, ''); // tira as cores ANSI do log
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function verificar(descricao, condicao, detalhe) {
  if (condicao) {
    aprovados += 1;
    console.log(`  ok    ${descricao}`);
  } else {
    console.log(`  FALHA ${descricao}${detalhe ? ` -- ${detalhe}` : ''}`);
    falhas.push(descricao);
  }
}

/* Espera ate a condicao valer (ou o prazo acabar). */
async function ate(condicao, ms) {
  const fim = Date.now() + (ms || 8000);
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await esperar(200);
  }
  return Boolean(await condicao());
}

function subir(script) {
  const p = spawn(process.execPath, [path.join(RAIZ, script)], { env: AMBIENTE, stdio: ['ignore', 'pipe', 'pipe'] });
  p.saida = '';
  p.stdout.on('data', (d) => {
    p.saida += d.toString();
    if (process.env.VERBOSE) process.stdout.write(`    [${path.basename(path.dirname(script))}] ${d}`);
  });
  p.stderr.on('data', (d) => process.stderr.write(`    [${script} erro] ${d}`));
  processos.push(p);
  return p;
}

function docker(args) {
  return execSync(`docker compose ${args}`, { cwd: RAIZ, stdio: 'pipe', timeout: 120000 }).toString();
}

// ---------------------------------------------------------------------------
// Papel do dispositivo
// ---------------------------------------------------------------------------

const INICIO = Date.now();
const millis = () => Date.now() - INICIO;
let sequencia = 0;

function base(eventType) {
  sequencia += 1;
  return {
    schemaVersion: 1,
    eventId: `${DEVICE_ID}:${BOOT_ID}:${String(sequencia).padStart(6, '0')}`,
    eventType, deviceId: DEVICE_ID, entityId: 'vaso-01', bootId: BOOT_ID,
    eventTimeMs: millis(), sequence: sequencia
  };
}

const solo = (valor, ec) => ({
  ...base('LeituraUmidadeSolo'), value: valor, unit: 'pct_simulado', valid: true,
  soilTempC: 24, ecApparentUsCm: Math.round(ec * 0.9), ec25UsCm: ec, ecValid: true
});
const nivel = (reservatorio, pct) => ({
  ...base('NivelReservatorio'), reservoir: reservatorio, valid: true, distanceCm: 20 - pct / 10, levelPct: pct
});

// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('Teste de integracao da persistencia (TimescaleDB)');

  // --- banco de teste: migra, limpa, cadastra --------------------------------
  const cfg = contrato.carregarConfig();
  cfg.persistencia.banco = BANCO;
  cfg.persistencia.habilitada = 1;
  cfg.persistencia.esperaPartidaMs = 3000;
  const banco = new Persistencia(cfg);
  if (!(await banco.iniciar())) {
    console.log('  banco indisponivel: rode `npm run seguranca` e `npm run banco` antes deste teste.');
    process.exit(2);
  }
  const q = async (sql, params) => (await banco.executor(sql, params)).rows;
  await q(`TRUNCATE telemetria_solo, telemetria_ambiente, telemetria_reservatorio, telemetria_luz, comandos, confirmacoes,
           alertas, transicoes, estado_servico, fotos, vasos, grupos, especies`);
  for (const sql of comandosSql(path.join(RAIZ, 'persistencia', 'seed.sql'))) await q(sql);
  console.log(`  banco ${BANCO} limpo e com o cadastro de persistencia/seed.sql (vaso-01 = jiboia)`);

  // --- broker em porta livre e servico ---------------------------------------
  const reserva = require('net').createServer();
  await new Promise((r) => reserva.listen(0, '127.0.0.1', r));
  const porta = reserva.address().port;
  await new Promise((r) => reserva.close(r));
  AMBIENTE.BROKER_PORT = String(porta);
  AMBIENTE.MQTT_URL = `mqtts://127.0.0.1:${porta}`;
  seguranca.garantirMaterial();

  subir('broker-local/broker.js');
  await esperar(1200);
  let servico = subir('consumidor-servico/src/main.js');

  const disp = contrato.conectar({ mqtt: { url: AMBIENTE.MQTT_URL } }, DEVICE_ID, {
    clientId: `${DEVICE_ID}-${BOOT_ID}`, reconnectPeriod: 1000
  });
  await new Promise((r) => disp.once('connect', r));
  await new Promise((r, j) => disp.subscribe([T.comando, T.atuador], { qos: 1 }, (e) => (e ? j(e) : r())));

  const comandos = []; // { topico, cmd, recebidoEm }
  disp.on('message', (topico, buf) => {
    const texto = buf.toString();
    const cmd = JSON.parse(texto);
    comandos.push({ topico, cmd, recebidoEm: Date.now() });
    const ok = seguranca.verificarAssinatura(CHAVE, topico, texto).ok;
    const ack = {
      schemaVersion: 1, eventType: 'ConfirmacaoAtuacao', deviceId: DEVICE_ID, bootId: BOOT_ID,
      commandId: cmd.commandId, correlationId: cmd.correlationId,
      result: !ok ? 'REJEITADO_ASSINATURA' : millis() >= cmd.expiresAtDeviceMs ? 'REJEITADO_EXPIRADO' : 'EXECUTADO',
      appliedAtDeviceMs: millis(), detail: cmd.action
    };
    const tAck = topico === T.comando ? T.ack : T.ackAtuador;
    disp.publish(tAck, seguranca.assinar(CHAVE, tAck, ack), { qos: 1 });
  });

  const publicar = (topico, payload) =>
    new Promise((r) => disp.publish(topico, seguranca.assinar(CHAVE, topico, payload), { qos: 1 }, r));

  // Reservatorios cheios e PARADOS durante todo o teste: a agua "nao sai", e
  // e isso que faz a verificacao cruzada do efeito falhar no cenario 2.
  const tNivel = setInterval(() => {
    publicar(T.nivel, nivel('AGUA', 80));
    publicar(T.nivel, nivel('ADUBO', 80));
  }, 1000);

  let soloAtual = { valor: 60, ec: 1200 };
  const enviados = [];
  const tSolo = setInterval(() => {
    const l = solo(soloAtual.valor, soloAtual.ec);
    enviados.push(l);
    publicar(T.solo, l);
  }, 700);

  await ate(() => servico.saida.includes('assinaturas ativas'), 10000);
  verificar('servico sobe com o banco e informa que nao havia estado salvo',
    servico.saida.includes('nenhum estado salvo'), 'sem a linha "nenhum estado salvo"');
  verificar('perfil do vaso carregado do cadastro (jiboia, sala)',
    /PERFIL.*vaso-01 "Jiboia da sala" especie=jiboia grupo=sala/.test(servico.saida));

  // -------------------------------------------------------------------------
  console.log('1. Gravacao -- historico nas hypertables');
  // -------------------------------------------------------------------------
  // Adubacao: EC baixa com solo umido -> mede -> dose (BOMBA_ADUBO PULSO).
  soloAtual = { valor: 60, ec: 500 };
  const houveDose = await ate(() => comandos.some((c) => c.cmd.actuator === 'BOMBA_ADUBO' && c.cmd.action === 'PULSO'), 20000);
  verificar('servico emite a dose de fertilizante (EC 500 < 800)', houveDose);
  await ate(() => servico.saida.includes('dose_executada'), 5000);

  // Irrigacao: solo seco -> pulso -> ack EXECUTADO -> nada muda -> FALHA_IRRIGACAO.
  soloAtual = { valor: 20, ec: 500 };
  const houvePulso = await ate(() => comandos.some((c) => c.cmd.action === 'PULSO_IRRIGACAO'), 10000);
  verificar('servico emite PULSO_IRRIGACAO com o solo a 20%', houvePulso);
  const bloqueou = await ate(() => servico.saida.includes('irrigacao automatica bloqueada'), 10000);
  verificar('sem efeito confirmado, a irrigacao automatica e bloqueada', bloqueou);

  // eventId repetido (retry QoS 1): o servico descarta, o banco nao duplica.
  const repetido = enviados[2];
  await publicar(T.solo, repetido);
  await esperar(1500);

  const n = async (sql, params) => Number((await q(sql, params))[0].n);
  verificar('telemetria de solo gravada (inclui EC e temperatura do substrato)',
    await n("SELECT count(*) AS n FROM telemetria_solo WHERE ec25_us_cm = 500 AND solo_temp_c = 24") > 0);
  verificar('eventId repetido gravado uma unica vez',
    await n('SELECT count(*) AS n FROM telemetria_solo WHERE event_id = $1', [repetido.eventId]) === 1);
  verificar('telemetria dos dois reservatorios gravada',
    await n("SELECT count(DISTINCT reservatorio) AS n FROM telemetria_reservatorio") === 2);
  verificar('comando de irrigacao e de adubo gravados',
    await n("SELECT count(*) AS n FROM comandos WHERE acao = 'PULSO_IRRIGACAO'") > 0 &&
    await n("SELECT count(*) AS n FROM comandos WHERE atuador = 'BOMBA_ADUBO' AND acao = 'PULSO'") === 1);
  verificar('ack EXECUTADO gravado e ligado ao comando pelo command_id',
    await n(`SELECT count(*) AS n FROM confirmacoes a JOIN comandos c ON c.command_id = a.command_id
             WHERE a.resultado = 'EXECUTADO' AND c.acao = 'PULSO_IRRIGACAO'`) > 0);
  verificar('alertas SOLO_SECO e FALHA_IRRIGACAO gravados',
    await n("SELECT count(DISTINCT tipo) AS n FROM alertas WHERE tipo IN ('SOLO_SECO','FALHA_IRRIGACAO')") === 2);
  verificar('transicoes gravadas (solo AUTORIZADO, adubacao VERIFICANDO, verificacao BLOQUEADA)',
    await n(`SELECT count(*) AS n FROM transicoes WHERE (componente='solo' AND atual='AUTORIZADO')
             OR (componente='adubacao' AND atual='VERIFICANDO') OR (componente='verificacao' AND atual='BLOQUEADA')`) >= 3);
  verificar('agregado continuo solo_1min responde (time_bucket)',
    await n('SELECT count(*) AS n FROM solo_1min WHERE vaso_id = $1', ['vaso-01']) > 0);

  // -------------------------------------------------------------------------
  console.log('2. Preservacao -- SIGKILL no servico e nova partida');
  // -------------------------------------------------------------------------
  await ate(async () => {
    const r = await q("SELECT valor FROM estado_servico WHERE chave = 'vaso:vaso-01'");
    return r[0] && r[0].valor.verificacao.bloqueadaDesde && r[0].valor.adubacao.doses.length === 1;
  }, 5000);
  const snap = (await q("SELECT valor FROM estado_servico WHERE chave = 'vaso:vaso-01'"))[0];
  verificar('snapshot salvo com 1 dose, bloqueio e eventIds',
    snap && snap.valor.adubacao.doses.length === 1 && snap.valor.verificacao.bloqueadaDesde &&
    snap.valor.solo.eventIds.includes(repetido.eventId));
  const cmdAntes = Math.max(...comandos.filter((c) => c.topico === T.comando).map((c) => Number(c.cmd.commandId.slice(4))));

  servico.kill('SIGKILL'); // sem encerrar(): nada de ultimo snapshot "de despedida"
  await esperar(800);
  const comandosAntes = comandos.length;
  servico = subir('consumidor-servico/src/main.js');
  await ate(() => servico.saida.includes('assinaturas ativas'), 10000);

  verificar('na nova partida o estado e restaurado do banco', servico.saida.includes('restaurado do banco'));
  verificar('irrigacao continua bloqueada depois do reinicio', servico.saida.includes('irrigacao continua bloqueada (bomba_sem_fluxo)'));
  verificar('a dose aplicada antes do reinicio continua contando', servico.saida.includes('1 dose(s) na janela'));

  await publicar(T.solo, repetido);
  verificar('eventId visto ANTES do reinicio continua DUPLICADO',
    await ate(() => servico.saida.includes(`${repetido.eventId} ja processado`), 4000));

  soloAtual = { valor: 20, ec: 500 };
  await ate(() => servico.saida.includes('irrigacao_bloqueada_sem_efeito'), 8000);
  verificar('solo seco apos o reinicio NAO gera pulso (bloqueio preservado)',
    servico.saida.includes('irrigacao_bloqueada_sem_efeito') &&
    !comandos.slice(comandosAntes).some((c) => c.cmd.action === 'PULSO_IRRIGACAO'));

  soloAtual = { valor: 60, ec: 500 };
  const limite = await ate(() => servico.saida.includes('limite_de_doses_na_janela'), 12000);
  verificar('EC baixa de novo: limite de doses impede segunda dose (doses preservadas)',
    limite && !comandos.slice(comandosAntes).some((c) => c.cmd.actuator === 'BOMBA_ADUBO' && c.cmd.action === 'PULSO'));
  const cmdsDepois = comandos.slice(comandosAntes).filter((c) => c.topico === T.comando);
  verificar('contador de comandos continua de onde parou (sem reusar idempotencyKey)',
    cmdsDepois.every((c) => Number(c.cmd.commandId.slice(4)) > cmdAntes),
    `antes ate cmd-${cmdAntes}, depois ${cmdsDepois.map((c) => c.cmd.commandId).join(',')}`);

  // -------------------------------------------------------------------------
  if (!SEM_QUEDA) {
    console.log('3. Falha do banco -- servico continua, fila despejada na volta');
    // -----------------------------------------------------------------------
    const antesDaQueda = await n('SELECT count(*) AS n FROM telemetria_solo');
    await banco.fechar();
    docker('stop timescaledb');
    const marca = enviados.length;
    const caiu = await ate(() => servico.saida.includes('banco indisponivel'), 15000);
    verificar('servico percebe a queda do banco', caiu);
    await esperar(3000);
    const duranteQueda = enviados.slice(marca).map((l) => l.eventId);
    verificar('servico continua processando telemetria sem o banco',
      duranteQueda.length >= 3 && duranteQueda.every((id) => servico.saida.includes(id)),
      `${duranteQueda.length} leituras durante a queda`);
    verificar('servico continua vivo (nao caiu junto com o banco)', servico.exitCode === null);

    docker('start timescaledb');
    docker('up -d --wait timescaledb');
    const voltou = await ate(() => /banco de volta: \d+ gravacoes pendentes despejadas/.test(servico.saida), 30000);
    verificar('na volta do banco a fila e despejada', voltou);

    const banco2 = new Persistencia(cfg);
    await banco2.iniciar();
    const q2 = async (sql, params) => (await banco2.executor(sql, params)).rows;
    const gravadosNaQueda = Number((await q2('SELECT count(*) AS n FROM telemetria_solo WHERE event_id = ANY($1)', [duranteQueda]))[0].n);
    verificar('leituras recebidas durante a queda estao no banco', gravadosNaQueda === duranteQueda.length,
      `${gravadosNaQueda}/${duranteQueda.length}`);
    // ---------------------------------------------------------------------
    console.log('4. Reinicio do conteiner -- dados preservados no volume');
    // ---------------------------------------------------------------------
    verificar('linhas gravadas antes da parada continuam la',
      Number((await q2('SELECT count(*) AS n FROM telemetria_solo'))[0].n) >= antesDaQueda);
    verificar('cadastro continua la', (await q2("SELECT especie_id FROM vasos WHERE vaso_id='vaso-01'"))[0].especie_id === 'jiboia');
    await banco2.fechar();
    banco.conectado = false;
    banco.encerrando = false;
    banco.pool = null;
    banco.executor = null;
    await banco.iniciar();
  }

  // -------------------------------------------------------------------------
  console.log('5. Perfil por especie e por vaso -- sem reiniciar o servico');
  // -------------------------------------------------------------------------
  soloAtual = { valor: 40, ec: 1200 };
  await esperar(1500);
  const marcaLog = servico.saida.length;
  await esperar(1500);
  const trecho = semCor(servico.saida.slice(marcaLog));
  verificar('jiboia (liga < 30%): solo a 40% fica NORMAL',
    /ACEITO\s+NORMAL secas=0/.test(trecho) && !/AGUARDANDO|AUTORIZADO/.test(trecho));

  const t1 = new Date();
  await q("UPDATE vasos SET especie_id = 'samambaia', atualizado_em = now() WHERE vaso_id = 'vaso-01'");
  verificar('troca para samambaia aplicada: limiarLiga 30 -> 45 (especie:samambaia)',
    await ate(() => servico.saida.includes('regra.limiarLiga: 30 -> 45 (especie:samambaia)'), 6000));
  verificar('samambaia: o mesmo solo a 40% passa a AUTORIZADO',
    await ate(async () => (await q("SELECT count(*) AS n FROM transicoes WHERE componente='solo' AND atual='AUTORIZADO' AND ts > $1", [t1]))[0].n > 0, 8000));

  const t2 = new Date();
  await q(`UPDATE vasos SET parametros = '{"regra": {"limiarLiga": 35}}'::jsonb, atualizado_em = now() WHERE vaso_id = 'vaso-01'`);
  verificar('parametro do VASO vence o da especie: limiarLiga 45 -> 35 (vaso:vaso-01)',
    await ate(() => servico.saida.includes('regra.limiarLiga: 45 -> 35 (vaso:vaso-01)'), 6000));
  verificar('com liga < 35%, solo a 40% volta a NORMAL',
    await ate(async () => (await q("SELECT count(*) AS n FROM transicoes WHERE componente='solo' AND atual='NORMAL' AND ts > $1", [t2]))[0].n > 0, 8000));
  verificar('troca de perfil registrada em transicoes',
    (await q("SELECT count(*) AS n FROM transicoes WHERE componente='perfil'"))[0].n >= 2);

  await q(`UPDATE vasos SET parametros = '{"regra": {"limiarLiga": "muito"}}'::jsonb WHERE vaso_id = 'vaso-01'`);
  verificar('perfil invalido no cadastro e ignorado (schema), sem derrubar o servico',
    await ate(() => servico.saida.includes('camada vaso:vaso-01 ignorada'), 6000) && servico.exitCode === null);

  // -------------------------------------------------------------------------
  console.log('6. Menor privilegio no banco');
  // -------------------------------------------------------------------------
  const { Client } = require('pg');
  const env = util.parseEnv(fs.readFileSync(path.join(RAIZ, '.env'), 'utf8'));
  const leitor = new Client({ host: cfg.persistencia.host, port: cfg.persistencia.porta, database: BANCO,
    user: 'leitor_app', password: env.PERSISTENCIA_SENHA_LEITOR });
  await leitor.connect();
  const lidos = await leitor.query('SELECT count(*)::int AS n FROM naodenemagua.alertas');
  verificar('leitor_app consegue ler o historico', lidos.rows[0].n > 0);
  let negado = null;
  try {
    await leitor.query("INSERT INTO naodenemagua.especies (id, nome_popular) VALUES ('x', 'x')");
  } catch (e) {
    negado = e.code;
  }
  verificar('leitor_app NAO consegue gravar (42501 permissao negada)', negado === '42501', `codigo ${negado}`);
  await leitor.end();

  clearInterval(tNivel);
  clearInterval(tSolo);
  disp.end(true);
  await banco.fechar();
}

function encerrar(codigo) {
  for (const p of processos) {
    try { p.kill(); } catch (e) { /* ja encerrado */ }
  }
  console.log('');
  console.log(`${aprovados} verificacoes aprovadas, ${falhas.length} falhas`);
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(codigo !== undefined ? codigo : falhas.length ? 1 : 0);
}

main().then(() => encerrar()).catch((e) => {
  console.error(e);
  encerrar(1);
});

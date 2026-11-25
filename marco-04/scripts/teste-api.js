'use strict';
/*
 * Teste de integracao da API de historico -- `npm run teste:api`.
 *
 * Requer o banco no ar (`npm run banco`). Usa o banco de TESTE
 * (naodenemagua_teste): grava dados conhecidos com o papel do servico, sobe a
 * API como subprocesso (que le com leitor_app) e confere, pela rede e por TLS:
 *
 *   1. canal: sem TLS nao conecta; cliente que nao confia na CA do grupo recusa
 *   2. identidade: sem credencial, senha errada, usuario inexistente -> 401
 *   3. autorizacao: outro papel e outro vaso -> 403
 *   4. entrada: vasoId malicioso e periodo fora da faixa -> 400; POST -> 405
 *   5. dados: series, exclusoes (atrasada, replayed, invalida, outro vaso,
 *      fora do periodo), resumo e alertas -- e tudo dentro do contrato
 *   6. forca bruta: senhas erradas em sequencia -> 429 sem conferir a senha
 */

const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const contrato = require('../contrato');
const seguranca = require('../seguranca');
const { Persistencia } = require('../persistencia');

const RAIZ = path.resolve(__dirname, '..');
const BANCO = 'naodenemagua_teste';
const falhas = [];
let aprovados = 0;

function verificar(descricao, condicao, detalhe) {
  if (condicao) {
    aprovados += 1;
    console.log(`  ok    ${descricao}`);
  } else {
    console.log(`  FALHA ${descricao}${detalhe ? ` -- ${detalhe}` : ''}`);
    falhas.push(descricao);
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function pedir(porta, caminho, { cred, ca, metodo = 'GET', host = 'localhost' } = {}) {
  // ca: false = cliente que confia SO nas CAs do sistema (nao na do grupo).
  const confia = ca === false ? undefined : (ca || seguranca.caPropria());
  return new Promise((resolve) => {
    const headers = cred ? { Authorization: 'Basic ' + Buffer.from(cred).toString('base64') } : {};
    const req = https.request({ host, port: porta, path: caminho, method: metodo, ca: confia, headers, rejectUnauthorized: true }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(corpo); } catch { /* corpo nao JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', (e) => resolve({ status: 'ERRO', erro: e.code || e.message }));
    req.end();
  });
}

async function main() {
  console.log('');
  console.log('Teste de integracao da API de historico (HTTPS + leitor_app)');

  // --- dados conhecidos no banco de teste ------------------------------------------
  const cfg = contrato.carregarConfig();
  cfg.persistencia.banco = BANCO;
  cfg.persistencia.habilitada = 1;
  const banco = new Persistencia(cfg);
  if (!(await banco.iniciar())) {
    console.log('  banco indisponivel: rode `npm run seguranca` e `npm run banco` antes deste teste.');
    process.exit(2);
  }
  const q = async (sql, params) => (await banco.executor(sql, params)).rows;
  await q(`TRUNCATE telemetria_solo, telemetria_ambiente, telemetria_reservatorio, telemetria_luz, comandos, alertas`);
  const id = () => crypto.randomUUID();
  const ha = (min) => new Date(Date.now() - min * 60000);

  for (let m = 1; m <= 10; m++) {
    await q(`INSERT INTO telemetria_solo (id, ts, vaso_id, device_id, event_id, umidade_pct, valida) VALUES ($1,$2,'vaso-01','sim-vaso-01',$3,40,true)`, [id(), ha(m), `e-solo-${m}`]);
    await q(`INSERT INTO telemetria_ambiente (id, ts, vaso_id, device_id, event_id, umidade_ar_pct, temperatura_c, valida) VALUES ($1,$2,'vaso-01','sim-vaso-01',$3,55,24,true)`, [id(), ha(m), `e-amb-${m}`]);
    await q(`INSERT INTO telemetria_luz (id, ts, vaso_id, device_id, event_id, measured_at, lux, valida, atrasada) VALUES ($1,$2,'vaso-01','app-vaso-01',$3,$2,800,true,false)`, [id(), ha(m), `e-luz-${m}`]);
    await q(`INSERT INTO telemetria_reservatorio (id, ts, vaso_id, device_id, event_id, reservatorio, nivel_pct, valida) VALUES ($1,$2,'vaso-01','sim-vaso-01',$3,'AGUA',70,true),($4,$2,'vaso-01','sim-vaso-01',$5,'ADUBO',90,true)`,
      [id(), ha(m), `e-agua-${m}`, id(), `e-adubo-${m}`]);
  }
  // O que NAO pode aparecer: invalida, atrasada, replayed, outro vaso, fora do periodo.
  await q(`INSERT INTO telemetria_solo (id, ts, vaso_id, device_id, event_id, umidade_pct, valida) VALUES ($1,$2,'vaso-01','sim-vaso-01','e-solo-invalida',99,false)`, [id(), ha(3)]);
  await q(`INSERT INTO telemetria_luz (id, ts, vaso_id, device_id, event_id, measured_at, lux, valida, atrasada) VALUES ($1,$2,'vaso-01','app-vaso-01','e-luz-atrasada',$2,99999,true,true)`, [id(), ha(3)]);
  await q(`INSERT INTO telemetria_reservatorio (id, ts, vaso_id, device_id, event_id, reservatorio, nivel_pct, valida, replayed) VALUES ($1,$2,'vaso-01','sim-vaso-01','e-agua-replay','AGUA',5,true,true)`, [id(), ha(3)]);
  await q(`INSERT INTO telemetria_solo (id, ts, vaso_id, device_id, event_id, umidade_pct, valida) VALUES ($1,$2,'vaso-02','x','e-solo-v2',5,true)`, [id(), ha(3)]);
  const comando = (atuador, acao, min) => q(
    `INSERT INTO comandos (id, ts, vaso_id, command_id, tipo, atuador, acao, payload) VALUES ($1,$2,'vaso-01',$3,'t',$4,$5,'{}'::jsonb)`,
    [id(), ha(min), `c-${crypto.randomBytes(3).toString('hex')}`, atuador, acao]);
  await comando('BOMBA_AGUA', 'PULSO_IRRIGACAO', 5);
  await comando('BOMBA_AGUA', 'PULSO_IRRIGACAO', 8);
  await comando('BOMBA_AGUA', 'PARAR_IRRIGACAO', 7);
  await comando('BOMBA_ADUBO', 'PULSO', 6);
  const alerta = (vaso, tipo, sev, min) => q(
    `INSERT INTO alertas (id, ts, vaso_id, event_id, tipo, severidade, mensagem) VALUES ($1,$2,$3,$4,$5,$6,'teste')`,
    [id(), ha(min), vaso, `a-${crypto.randomBytes(3).toString('hex')}`, tipo, sev]);
  await alerta('vaso-01', 'SOLO_SECO', 'ATENCAO', 9);
  await alerta('vaso-01', 'FALHA_IRRIGACAO', 'CRITICO', 4);
  await alerta('vaso-01', 'LUZ_INSUFICIENTE', 'ATENCAO', 2);
  await alerta('vaso-01', 'DADO_OBSOLETO', 'ATENCAO', 60 * 24 * 10); // 10 dias: fora de 168 h
  await alerta('vaso-02', 'SOLO_SECO', 'ATENCAO', 3);
  await banco.fechar(1000);
  console.log(`  banco ${BANCO}: 10 min de telemetria conhecida + linhas que devem ser excluidas`);

  // --- API em porta livre ------------------------------------------------------------
  const reserva = require('net').createServer();
  await new Promise((r) => reserva.listen(0, '127.0.0.1', r));
  const porta = reserva.address().port;
  await new Promise((r) => reserva.close(r));
  seguranca.garantirMaterial();
  let saida = '';
  const api = spawn(process.execPath, [path.join(RAIZ, 'api-historico/src/main.js')], {
    env: { ...process.env, PERSISTENCIA_BANCO: BANCO, API_PORTA: String(porta), API_TENTATIVAS_MAX: '5' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  api.stdout.on('data', (d) => { saida += d; if (process.env.VERBOSE) process.stdout.write(`    [api] ${d}`); });
  api.stderr.on('data', (d) => process.stderr.write(`    [api erro] ${d}`));
  for (let i = 0; i < 50 && !/OUVINDO/.test(saida); i++) await esperar(100);
  console.log(`  api em https://localhost:${porta}`);

  const app = `app-vaso-01:${seguranca.senhaDe('app-vaso-01')}`;
  const hist = (qs, opcoes) => pedir(porta, `/v1/vasos/vaso-01/historico${qs || ''}`, opcoes);

  console.log('1. Canal');
  const semTls = await new Promise((r) => {
    const req = http.get({ host: 'localhost', port: porta, path: '/v1/saude' }, (res) => r(`HTTP ${res.statusCode}`));
    req.on('error', (e) => r(e.code || e.message));
    req.setTimeout(2000, () => { req.destroy(); r('timeout'); });
  });
  verificar('HTTP sem TLS nao obtem resposta', !/^HTTP 2/.test(semTls), semTls);
  const semCa = await pedir(porta, '/v1/saude', { ca: false });
  verificar('cliente que nao confia na CA do grupo recusa o servidor', semCa.status === 'ERRO', semCa.erro);
  const outroNome = await pedir(porta, '/v1/saude', { host: '127.0.0.2' });
  verificar('nome do servidor fora do certificado e recusado', outroNome.status === 'ERRO', outroNome.erro);

  console.log('2. Identidade');
  verificar('sem credencial: 401 com WWW-Authenticate', (await hist()).status === 401 && /Basic/.test((await hist()).headers['www-authenticate'] || ''));
  verificar('senha errada: 401', (await hist('', { cred: 'app-vaso-01:errada' })).status === 401);
  verificar('usuario inexistente: 401 (mesma resposta, nao revela quem existe)', (await hist('', { cred: 'fulano:x' })).status === 401);

  console.log('3. Autorizacao');
  const notif = await hist('', { cred: `notificador:${seguranca.senhaDe('notificador')}` });
  verificar('notificador (credencial valida, outro papel): 403', notif.status === 403, notif.status);
  const gateway = await hist('', { cred: `sim-vaso-01:${seguranca.senhaDe('sim-vaso-01')}` });
  verificar('gateway do proprio vaso: 403 (so o app le historico pela API)', gateway.status === 403, gateway.status);
  const outroVaso = await pedir(porta, '/v1/vasos/vaso-02/historico', { cred: app });
  verificar('app-vaso-01 pedindo o vaso-02: 403', outroVaso.status === 403, outroVaso.status);

  console.log('4. Entrada');
  const injecao = await pedir(porta, `/v1/vasos/${encodeURIComponent("vaso-01' OR '1'='1")}/historico`, { cred: app });
  verificar('vasoId com SQL: 400, sem consultar o banco', injecao.status === 400, injecao.status);
  verificar('horas=0 e horas=9999: 400', (await hist('?horas=0', { cred: app })).status === 400 && (await hist('?horas=9999', { cred: app })).status === 400);
  verificar('POST: 405 (somente leitura)', (await hist('', { cred: app, metodo: 'POST' })).status === 405);
  verificar('rota desconhecida: 404', (await pedir(porta, '/v1/admin', { cred: app })).status === 404);

  console.log('5. Dados');
  const r = await hist('?horas=1', { cred: app });
  const h = r.json || {};
  verificar('historico de 1 h: 200 e dentro do contrato HistoricoVaso',
    r.status === 200 && contrato.validar('HistoricoVaso', h).ok, JSON.stringify(contrato.validar('HistoricoVaso', h)));
  const s = h.series || {};
  const so = (serie, valor) => (serie || []).length > 0 && serie.every((p) => p.v === valor);
  verificar('passo de 1 min para 1 h; ~10 pontos de solo', h.passoMin === 1 && (s.soloUmidadePct || []).length >= 9, `${(s.soloUmidadePct || []).length} pontos`);
  verificar('solo = 40% em todos os pontos (leitura invalida e outro vaso excluidos)', so(s.soloUmidadePct, 40));
  verificar('ar: 55% e 24 C (agregado continuo ambiente_1min)', so(s.arUmidadePct, 55) && so(s.arTemperaturaC, 24));
  verificar('luz = 800 lux (leitura atrasada de 99999 excluida)', so(s.luzLux, 800));
  verificar('reservatorios 70% / 90% (evento replayed excluido)', so(s.reservatorioAguaPct, 70) && so(s.reservatorioAduboPct, 90));
  verificar('resumo: 2 irrigacoes (PARAR nao conta), 1 dose, 3 alertas na hora',
    h.resumo && h.resumo.irrigacoes === 2 && h.resumo.dosesAdubo === 1 && h.resumo.alertas === 3, JSON.stringify(h.resumo));

  const a = await pedir(porta, '/v1/vasos/vaso-01/alertas?horas=168&limite=10', { cred: app });
  const tipos = ((a.json || {}).alertas || []).map((x) => x.tipo);
  verificar('alertas: dentro do contrato, mais novo primeiro, so do vaso e do periodo',
    a.status === 200 && contrato.validar('HistoricoAlertas', a.json).ok &&
      JSON.stringify(tipos) === JSON.stringify(['LUZ_INSUFICIENTE', 'FALHA_IRRIGACAO', 'SOLO_SECO']), JSON.stringify(tipos));
  const lim = await pedir(porta, '/v1/vasos/vaso-01/alertas?horas=168&limite=1', { cred: app });
  verificar('limite=1 devolve 1 alerta', ((lim.json || {}).alertas || []).length === 1);

  console.log('6. Forca bruta');
  let ultimo = null;
  for (let i = 0; i < 6; i++) ultimo = await hist('', { cred: 'app-vaso-01:errada' });
  verificar('depois de 5 senhas erradas: 429 com Retry-After', ultimo.status === 429 && Number(ultimo.headers['retry-after']) > 0, ultimo.status);
  const bloqueadoMesmoCerto = await hist('', { cred: app });
  verificar('bloqueado, nem a senha certa e conferida (scrypt nao vira alavanca de DoS)', bloqueadoMesmoCerto.status === 429);
  verificar('a API registra as recusas no log', /401 .*usuario=app-vaso-01/.test(saida) && /403 /.test(saida) && /429 /.test(saida));

  api.kill();
  console.log('');
  console.log(`Resultado: ${aprovados} passaram; ${falhas.length} falharam`);
  process.exit(falhas.length ? 1 : 0);
}

main().catch((e) => {
  console.error('erro no teste:', e);
  process.exit(1);
});

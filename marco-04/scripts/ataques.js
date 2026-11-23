'use strict';
/*
 * Ataques de demonstracao -- `npm run ataque -- <nome>`.
 *
 * Cada ataque e uma tentativa REAL contra o broker configurado (config.json ou
 * MQTT_URL). Rode com broker, servico e simulador ligados e observe a recusa no
 * terminal de quem defende: broker (TLS, senha, ACL), servico (HMAC) ou
 * dispositivo (HMAC do comando).
 *
 *   texto-puro          MQTT sem TLS na porta do broker         -> TLS_RECUSADO no broker
 *   sem-ca              TLS sem confiar na CA propria           -> o CLIENTE recusa o broker
 *   sem-senha           conexao sem credenciais                 -> AUTH_RECUSADA
 *   senha-errada        identidade valida, senha errada         -> AUTH_RECUSADA
 *   notificador-comanda notificador tenta ligar a bomba         -> PUBLISH_NEGADO + desconexao
 *   vaso-alheio         gateway assina comandos de outro vaso   -> SUBSCRIBE_NEGADO
 *   comando-forjado     comando sem a chave HMAC do servico     -> REJEITADO_ASSINATURA no dispositivo
 *                       (local: com a senha do servico "vazada"; publico: sem senha nenhuma)
 */

const mqtt = require('mqtt');
const crypto = require('crypto');
const contrato = require('../contrato');
const seguranca = require('../seguranca');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);
const url = cfg.mqtt.url;
const local = contrato.brokerLocal(url);
const porta = new URL(url).port || '8883';

const sufixo = () => crypto.randomBytes(2).toString('hex');

function opcoes(identidade, extras) {
  return {
    ca: local ? seguranca.caPropria() : undefined,
    rejectUnauthorized: true,
    username: identidade,
    password: identidade ? seguranca.senhaDe(identidade) : undefined,
    clientId: `${identidade || 'anonimo'}-ataque-${sufixo()}`,
    reconnectPeriod: 0,
    connectTimeout: 4000,
    ...(extras || {})
  };
}

function tentar(rotulo, alvo, opts) {
  return new Promise((resolve) => {
    const c = mqtt.connect(alvo, opts);
    let fim = false;
    const terminar = (texto, cliente) => {
      if (fim) return;
      fim = true;
      console.log(`  ${rotulo}: ${texto}`);
      resolve(cliente || (c.end(true), null));
    };
    c.on('connect', () => terminar('CONECTOU', c));
    c.on('error', (e) => terminar(`RECUSADO -- ${e.code !== undefined ? `codigo ${e.code}: ` : ''}${e.message}`));
    c.on('close', () => terminar('RECUSADO -- conexao encerrada antes do CONNACK'));
    setTimeout(() => terminar('RECUSADO -- sem resposta no prazo'), 5000);
  });
}

const comandoForjado = () => ({
  schemaVersion: 1,
  commandId: `cmd-forjado-${sufixo()}`,
  idempotencyKey: `cmd-forjado-${sufixo()}`,
  commandType: 'ComandoIrrigacao',
  targetId: cfg.identidade.vasoId,
  action: 'PULSO_IRRIGACAO',
  durationMs: 60000,
  correlationId: 'atacante:0:0',
  correlationEventTimeMs: 0,
  ttlMs: 99999999,
  expiresAtDeviceMs: 99999999,
  reason: 'ataque_de_demonstracao'
});

const ATAQUES = {
  async 'texto-puro'() {
    await tentar('MQTT sem TLS', `mqtt://${new URL(url).hostname}:${porta}`, opcoes('observador', { ca: undefined }));
  },

  async 'sem-ca'() {
    await tentar('TLS sem a CA propria', url, opcoes('observador', { ca: undefined }));
  },

  async 'sem-senha'() {
    await tentar('sem credenciais', url, opcoes(null));
  },

  async 'senha-errada'() {
    await tentar('sim-vaso-01 com senha errada', url, opcoes('sim-vaso-01', { password: 'chute' }));
  },

  async 'notificador-comanda'() {
    const c = await tentar('notificador', url, opcoes('notificador'));
    if (!c) return;
    const caiu = new Promise((r) => c.on('close', () => r(true)));
    c.publish(topicos.comandoIrrigacao, JSON.stringify(comandoForjado()), { qos: 1 });
    console.log(`  publicou PULSO_IRRIGACAO em ${topicos.comandoIrrigacao}`);
    const derrubado = await Promise.race([caiu, new Promise((r) => setTimeout(() => r(false), 2000))]);
    console.log(`  ${derrubado ? 'broker DERRUBOU a conexao: publicacao negada pela ACL' : 'continua conectado (ACL nao aplicada?)'}`);
    c.end(true);
  },

  async 'vaso-alheio'() {
    const c = await tentar('sim-vaso-01', url, opcoes('sim-vaso-01'));
    if (!c) return;
    const alheio = `${cfg.identidade.prefixoTopico}/vaso/vaso-02/command/irrigacao`;
    await new Promise((r) =>
      c.subscribe(alheio, { qos: 1 }, (e) => {
        console.log(`  assinar ${alheio}: ${e ? `NEGADO (${e.message})` : 'CONCEDIDO'}`);
        r();
      }));
    c.end(true);
  },

  async 'comando-forjado'() {
    // Local: o atacante tem a SENHA do servico (vazou), mas nao a chave HMAC.
    // Publico: nao precisa de senha nenhuma -- qualquer um publica.
    const c = await tentar(local ? 'servico-irrigacao (senha vazada)' : 'anonimo no broker publico', url,
      local ? opcoes('servico-irrigacao') : { reconnectPeriod: 0, clientId: `anonimo-${sufixo()}` });
    if (!c) return;
    c.subscribe(topicos.ackIrrigacao, { qos: 1 });
    const cmd = comandoForjado();
    const chaveDoAtacante = crypto.randomBytes(32).toString('hex');
    c.on('message', (t, b) => {
      const ack = JSON.parse(b.toString());
      if (ack.commandId === cmd.commandId) {
        console.log(`  dispositivo ${ack.deviceId} respondeu ${ack.result} (${ack.detail})`);
        c.end(true);
        process.exit(0);
      }
    });
    c.publish(topicos.comandoIrrigacao, seguranca.assinar(chaveDoAtacante, topicos.comandoIrrigacao, cmd), { qos: 1 });
    console.log(`  publicou ${cmd.commandId} (PULSO de 60 s) assinado com uma chave que NAO e a do dispositivo`);
    setTimeout(() => {
      console.log('  nenhum ack em 5 s (o dispositivo esta ligado?)');
      c.end(true);
      process.exit(0);
    }, 5000);
  }
};

async function main() {
  const nome = process.argv[2];
  if (!ATAQUES[nome]) {
    console.log('uso: npm run ataque -- <nome>');
    console.log(`  ${Object.keys(ATAQUES).join('\n  ')}`);
    process.exit(1);
  }
  console.log('');
  console.log(`ATAQUE ${nome} contra ${url}`);
  await ATAQUES[nome]();
  if (nome !== 'comando-forjado') process.exit(0);
}

main().catch((e) => {
  console.error('erro:', e.message);
  process.exit(1);
});

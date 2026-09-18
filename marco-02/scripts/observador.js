'use strict';
/*
 * Observador -- SEGUNDO CONSUMIDOR do mesmo fluxo.
 *
 * Nao decide nada e nao comanda nada: apenas assina e imprime. Existe para
 * demonstrar, ao vivo, a consequencia pratica de ter escolhido publicacao e
 * assinatura em vez de uma chamada direta entre produtor e servico:
 *
 *   este processo pode ser ligado e desligado a qualquer momento, e NEM o
 *   produtor NEM o servico de irrigacao precisam saber que ele existe.
 *
 * E o mesmo lugar arquitetural que o aplicativo Android ocupara na evolucao
 * prevista: mais um assinante dos mesmos topicos, sem alteracao no produtor nem
 * no consumidor de decisao.
 *
 * Uso: node scripts/observador.js
 */

const mqtt = require('mqtt');
const contrato = require('../contrato');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);

const assinaturas = [
  topicos.telemetriaSolo,
  topicos.heartbeat,
  topicos.comandoIrrigacao,
  topicos.ackIrrigacao
];

const cliente = mqtt.connect(cfg.mqtt.url, {
  clientId: `observador-${Math.random().toString(16).slice(2, 8)}`
});

console.log('');
console.log('observador -- segundo consumidor (somente leitura)');
console.log(`  broker ${cfg.mqtt.url}`);
console.log('  assina os quatro topicos da fronteira e apenas imprime.');
console.log('  Ligar ou desligar este processo nao afeta produtor nem servico.');
console.log('');

cliente.on('connect', () => {
  cliente.subscribe(assinaturas, { qos: cfg.mqtt.qos }, (e) => {
    if (e) console.log('erro ao assinar:', e.message);
    else assinaturas.forEach((t) => console.log(`  assinado ${t}`));
    console.log('');
  });
});

cliente.on('message', (topico, buffer) => {
  const curto = topico.split('/').slice(-2).join('/');
  const marca = new Date().toISOString().slice(11, 23);

  const bruto = contrato.desserializar(buffer);
  if (!bruto.ok) {
    console.log(`${marca}  ${curto.padEnd(22)} <payload nao e JSON: ${bruto.detalhe}>`);
    return;
  }

  const p = bruto.payload;
  let resumo;

  if (p.eventType === 'LeituraUmidadeSolo') {
    resumo = `${p.eventId}  valor=${p.value}%${p.replayed ? '  (replayed)' : ''}`;
  } else if (p.eventType === 'EstadoConectividade') {
    resumo = `state=${p.state}  silencio=${p.value !== undefined ? p.value + 'ms' : '-'}`;
  } else if (p.commandType === 'ComandoIrrigacao') {
    resumo = `${p.commandId}  ${p.action}  motivo=${p.reason}`;
  } else if (p.eventType === 'ConfirmacaoAtuacao') {
    resumo = `${p.commandId}  ${p.result}`;
  } else {
    resumo = JSON.stringify(p).slice(0, 90);
  }

  console.log(`${marca}  ${curto.padEnd(22)} ${resumo}`);
});

cliente.on('error', (e) => console.log('erro:', e.message));

process.on('SIGINT', () => cliente.end(true, () => process.exit(0)));

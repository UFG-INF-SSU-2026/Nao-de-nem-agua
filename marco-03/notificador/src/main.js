'use strict';

// Consumidor independente e somente leitura. Não possui caminho de publicação.
const mqtt = require('mqtt');
const { randomUUID } = require('crypto');
const contrato = require('../../contrato');
const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);
const vistos = new Set();
const LIMITE = 500;
const cliente = mqtt.connect(cfg.mqtt.url, {
  clientId: `notificador-${randomUUID()}`, clean: true,
  reconnectPeriod: 1000, connectTimeout: 8000
});

cliente.on('connect', () => cliente.subscribe(topicos.alertas, { qos: 1 }, erro => {
  console.log(erro ? `ERRO_ASSINATURA ${erro.message}` : `ASSINATURA_ATIVA ${topicos.alertas}`);
}));
cliente.on('error', erro => console.log(`ERRO_MQTT ${erro.message}`));
cliente.on('reconnect', () => console.log('RECONECTANDO'));

function descartar(motivo, p) {
  console.log(`DESCARTADO ${motivo} ${p?.eventId || ''}`);
}

function cartao(p) {
  const cores = { INFO: '\x1b[36m', ATENCAO: '\x1b[33m', CRITICO: '\x1b[31m' };
  const colorir = process.stdout.isTTY && !process.env.NO_COLOR;
  const linhas = [`${p.severity} — ${p.alertType.replaceAll('_', ' ')}`, `Vaso: ${p.entityId}`,
    p.message, `Evento: ${p.eventId}`, `Correlação: ${p.correlationId}`];
  // Quebra linhas longas sem truncar a correlação usada na auditoria.
  const partes = linhas.flatMap(l => Array.from(l.matchAll(/.{1,76}/gu), m => m[0]));
  const largura = Math.max(...partes.map(l => [...l].length));
  const borda = '═'.repeat(largura + 2);
  console.log((colorir ? cores[p.severity] : '') + `╔${borda}╗\n` +
    partes.map(l => `║ ${l}${' '.repeat(largura - [...l].length)} ║`).join('\n') +
    `\n╚${borda}╝` + (colorir ? '\x1b[0m' : ''));
}

cliente.on('message', (topico, buffer) => {
  const bruto = contrato.desserializar(buffer);
  if (!bruto.ok) return descartar(bruto.motivo);
  const p = bruto.payload;
  const valido = contrato.validar('AlertaCuidado', p);
  if (!valido.ok) return descartar(valido.motivo, p);
  if (p.entityId !== cfg.identidade.vasoId || topico !== topicos.alertaCuidado) return descartar('ORIGEM_INVALIDA', p);
  if (vistos.has(p.eventId)) return descartar('DUPLICADO', p);
  if (Date.now() >= Date.parse(p.issuedAt) + p.ttlMs) return descartar('EXPIRADO', p);
  vistos.add(p.eventId);
  if (vistos.size > LIMITE) vistos.delete(vistos.values().next().value);
  cartao(p);
});

function encerrar() {
  cliente.end(false, () => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

'use strict';
/*
 * Marco 4 -- app no broker publico: as mensagens do app levam HMAC proprio e as
 * do servico para o app levam ECDSA. Sem broker: so o contrato e a seguranca.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contrato = require('../../contrato');
const seguranca = require('../../seguranca');

const base = contrato.carregarConfig();
const comBroker = (url) => ({ ...base, mqtt: { ...base.mqtt, url }, seguranca: { ...base.seguranca, exigirAssinatura: true } });
const LOCAL = comBroker('mqtts://localhost:8883');
const PUBLICO = comBroker('mqtts://broker.hivemq.com:8883');
const T = contrato.topicos(base);

function pedido(extra) {
  return {
    schemaVersion: 1, eventType: 'SolicitacaoApp', requestId: 'req-00000001', deviceId: 'app-vaso-01',
    entityId: base.identidade.vasoId, action: 'RECONHECER_FALHA', createdAt: new Date().toISOString(), ttlMs: 30000,
    ...extra
  };
}

const assinadoPeloApp = (topico, obj, chave) =>
  seguranca.assinar(chave || seguranca.chaveApp('app-vaso-01').chave, topico, obj);

test('broker do grupo: pedido sem assinatura continua aceito (a ACL garante a origem)', () => {
  const r = contrato.abrirMensagemDoApp(LOCAL, T.solicitacaoApp, Buffer.from(JSON.stringify(pedido())));
  assert.equal(r.ok, true);
});

test('broker publico: pedido sem assinatura e recusado', () => {
  const r = contrato.abrirMensagemDoApp(PUBLICO, T.solicitacaoApp, Buffer.from(JSON.stringify(pedido())));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'ASSINATURA_AUSENTE');
});

test('broker publico: pedido com HMAC do app e aceito e continua no contrato', () => {
  const texto = assinadoPeloApp(T.solicitacaoApp, pedido());
  const r = contrato.abrirMensagemDoApp(PUBLICO, T.solicitacaoApp, Buffer.from(texto));
  assert.equal(r.ok, true);
  assert.equal(contrato.validar('SolicitacaoApp', r.payload).ok, true);
});

test('HMAC com outra chave, de outro topico ou corpo alterado e recusado nos dois brokers', () => {
  const outraChave = crypto.randomBytes(32).toString('hex');
  const forjado = assinadoPeloApp(T.solicitacaoApp, pedido(), outraChave);
  const outroTopico = assinadoPeloApp(T.telemetriaLuz, pedido());
  const alterado = assinadoPeloApp(T.solicitacaoApp, pedido()).replace('RECONHECER_FALHA', 'RECONHECER_FALHX');
  for (const cfg of [LOCAL, PUBLICO]) {
    for (const texto of [forjado, outroTopico, alterado]) {
      const r = contrato.abrirMensagemDoApp(cfg, T.solicitacaoApp, Buffer.from(texto));
      assert.equal(r.ok, false);
      assert.equal(r.motivo, 'ASSINATURA_INVALIDA');
    }
  }
});

test('o ESP32 nao se passa pelo app: deviceId sem chave de app e recusado', () => {
  const chaveEsp = seguranca.dispositivo('esp32-vaso-01').chave;
  const texto = seguranca.assinar(chaveEsp, T.solicitacaoApp, pedido({ deviceId: 'esp32-vaso-01' }));
  const r = contrato.abrirMensagemDoApp(PUBLICO, T.solicitacaoApp, Buffer.from(texto));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'APP_DESCONHECIDO');
});

test('a chave do app nao vale para outro vaso', () => {
  const topicoOutro = T.solicitacaoApp.replace(`/vaso/${base.identidade.vasoId}/`, '/vaso/vaso-99/');
  const texto = assinadoPeloApp(topicoOutro, pedido({ entityId: 'vaso-99' }));
  const r = contrato.abrirMensagemDoApp(PUBLICO, topicoOutro, Buffer.from(texto));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'VASO_NAO_PERTENCE_AO_APP');
});

test('ECDSA do servico: confere com a chave publica, falha com corpo, topico ou chave trocados', () => {
  const ev = { schemaVersion: 1, eventType: 'RespostaApp', requestId: 'req-00000001', result: 'EXECUTADA' };
  const texto = contrato.textoAssinadoParaApp(T.respostaApp, ev);
  assert.match(texto, /,"assinatura":"[0-9a-f]+"\}$/);
  assert.equal(seguranca.verificarAssinaturaServico(T.respostaApp, texto).ok, true);
  assert.equal(seguranca.verificarAssinaturaServico(T.estadoVaso, texto).ok, false);
  assert.equal(seguranca.verificarAssinaturaServico(T.respostaApp, texto.replace('EXECUTADA', 'REJEITADA')).ok, false);
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.equal(seguranca.verificarAssinaturaServico(T.respostaApp, texto, publicKey).ok, false);
  assert.equal(seguranca.verificarAssinaturaServico(T.respostaApp, JSON.stringify(ev)).motivo, 'ASSINATURA_AUSENTE');
});

test('mensagens assinadas pelo servico continuam dentro do contrato', () => {
  const alerta = {
    schemaVersion: 1, eventId: 'servico-irrigacao:abc:000001', eventType: 'AlertaCuidado', producerId: 'servico-irrigacao',
    entityId: base.identidade.vasoId, alertType: 'SOLO_SECO', severity: 'ATENCAO', message: 'teste',
    correlationId: 'x', issuedAt: new Date().toISOString(), ttlMs: 60000
  };
  const lido = JSON.parse(contrato.textoAssinadoParaApp(T.alertaCuidado, alerta));
  assert.equal(contrato.validar('AlertaCuidado', lido).ok, true);
});

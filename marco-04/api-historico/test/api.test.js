'use strict';
/* API de historico sem rede nem banco: parametros, identidade, autorizacao e limite de tentativas. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parametros, passoPara } = require('../src/consultas');
const { lerBasic, autorizar, LimiteTentativas } = require('../src/autenticacao');

const cfgApi = { horasMax: 168, limiteAlertas: 100 };
const qs = (s) => new URLSearchParams(s);

test('parametros validos e passo conforme o periodo', () => {
  const r = parametros(cfgApi, 'vaso-01', qs('horas=24'), 24);
  assert.equal(r.ok, true);
  assert.deepEqual(r.valores, { vasoId: 'vaso-01', horas: 24, limite: 50, passoMin: 5 });
  assert.equal(passoPara(6), 1);
  assert.equal(passoPara(48), 5);
  assert.equal(passoPara(168), 30);
});

test('parametros fora da faixa sao RECUSADOS, nao corrigidos', () => {
  for (const h of ['0', '169', '2.5', 'abc', '-1', '']) {
    assert.equal(parametros(cfgApi, 'vaso-01', qs(`horas=${h}`), 24).ok, false, `horas=${h}`);
  }
  assert.equal(parametros(cfgApi, 'vaso-01', qs('limite=101'), 24).ok, false);
});

test('vasoId so com o formato esperado (nada de SQL nem caminho)', () => {
  for (const v of ["vaso-01'; DROP TABLE alertas;--", '../etc', 'VASO-01', '', 'a'.repeat(41)]) {
    assert.equal(parametros(cfgApi, v, qs(''), 24).ok, false, v);
  }
});

test('Basic: le usuario e senha; recusa cabecalho malformado', () => {
  const h = 'Basic ' + Buffer.from('app-vaso-01:s3nh:a').toString('base64');
  assert.deepEqual(lerBasic(h), { usuario: 'app-vaso-01', senha: 's3nh:a' });
  assert.equal(lerBasic('Bearer abc'), null);
  assert.equal(lerBasic('Basic ' + Buffer.from('semdoispontos').toString('base64')), null);
  assert.equal(lerBasic(undefined), null);
});

test('autorizacao: so o app, so o proprio vaso', () => {
  const app = { nome: 'app-vaso-01', papel: 'app', vasoId: 'vaso-01' };
  assert.equal(autorizar(app, 'vaso-01').ok, true);
  assert.equal(autorizar(app, 'vaso-02').ok, false);
  assert.equal(autorizar({ nome: 'notificador', papel: 'notificador', vasoId: null }, 'vaso-01').ok, false);
  assert.equal(autorizar({ nome: 'sim-vaso-01', papel: 'gateway', vasoId: 'vaso-01' }, 'vaso-01').ok, false);
  assert.equal(autorizar(undefined, 'vaso-01').ok, false);
});

test('limite de tentativas por IP, com janela', () => {
  const l = new LimiteTentativas(3, 60000);
  for (let i = 0; i < 3; i++) l.falhou('1.2.3.4', 1000 + i);
  assert.equal(l.bloqueado('1.2.3.4', 2000), true);
  assert.equal(l.bloqueado('5.6.7.8', 2000), false); // outro IP nao paga
  assert.ok(l.esperaS('1.2.3.4', 2000) > 0);
  assert.equal(l.bloqueado('1.2.3.4', 1000 + 60000), false); // janela passou
  l.falhou('1.2.3.4', 70000);
  l.acertou('1.2.3.4');
  assert.equal(l.bloqueado('1.2.3.4', 70001), false);
});

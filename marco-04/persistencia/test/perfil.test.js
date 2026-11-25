'use strict';
/* Perfil de cuidado: precedencia, merge parcial, validacao e coerencia. */

const test = require('node:test');
const assert = require('node:assert/strict');
const perfil = require('../perfil');

const PADRAO = {
  'regra.limiarLiga': 30, 'regra.limiarDesliga': 50, 'regra.duracaoPulsoMs': 3000, 'regra.cooldownMs': 8000,
  'ambiente.umidadeArMin': 50, 'ambiente.histerese': 10,
  'adubacao.ec25MinUsCm': 800, 'adubacao.ec25MaxUsCm': 2000, 'adubacao.umidadeMinPct': 35,
  'adubacao.maxDoses': 1, 'adubacao.janelaDosesMs': 60000
};

const cadastro = (extras) => ({
  vaso_id: 'vaso-01', especie_id: 'samambaia', grupo_id: 'varanda',
  especie_parametros: { regra: { limiarLiga: 45, limiarDesliga: 65 }, ambiente: { umidadeArMin: 60 } },
  grupo_parametros: { regra: { limiarLiga: 40, cooldownMs: 6000 } },
  vaso_parametros: {},
  ...(extras || {})
});

test('as chaves do perfil saem do schema', () => {
  assert.deepEqual(perfil.CHAVES.sort(), Object.keys(PADRAO).sort());
});

test('sem cadastro: tudo vem do config.json', () => {
  const r = perfil.resolverPerfil(PADRAO, perfil.camadasDoCadastro(null), {});
  assert.equal(r.ok, true);
  assert.equal(r.valores['regra.limiarLiga'].valor, 30);
  assert.equal(r.valores['regra.limiarLiga'].origem, 'config.json');
});

test('precedencia: especie < grupo < vaso; o resto continua do padrao', () => {
  const r = perfil.resolverPerfil(PADRAO, perfil.camadasDoCadastro(cadastro()), {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.valores['regra.limiarLiga'], { valor: 40, origem: 'grupo:varanda' });
  assert.deepEqual(r.valores['regra.limiarDesliga'], { valor: 65, origem: 'especie:samambaia' });
  assert.deepEqual(r.valores['ambiente.umidadeArMin'], { valor: 60, origem: 'especie:samambaia' });
  assert.deepEqual(r.valores['adubacao.ec25MinUsCm'], { valor: 800, origem: 'config.json' });

  const comVaso = perfil.resolverPerfil(PADRAO,
    perfil.camadasDoCadastro(cadastro({ vaso_parametros: { regra: { limiarLiga: 35 } } })), {});
  assert.deepEqual(comVaso.valores['regra.limiarLiga'], { valor: 35, origem: 'vaso:vaso-01' });
});

test('variavel de ambiente vence o cadastro (alteracao ao vivo do README)', () => {
  const r = perfil.resolverPerfil(PADRAO, perfil.camadasDoCadastro(cadastro()), { 'regra.limiarLiga': 25 });
  assert.deepEqual(r.valores['regra.limiarLiga'], { valor: 25, origem: 'variavel de ambiente' });
});

test('camada invalida e ignorada com motivo; as outras valem', () => {
  const r = perfil.resolverPerfil(PADRAO,
    perfil.camadasDoCadastro(cadastro({ grupo_parametros: { regra: { limiarLiga: 'muito' } } })), {});
  assert.equal(r.ok, true);
  assert.equal(r.ignoradas.length, 1);
  assert.equal(r.ignoradas[0].origem, 'grupo:varanda');
  assert.equal(r.valores['regra.limiarLiga'].valor, 45); // da especie
});

test('campo desconhecido no perfil e rejeitado pelo schema', () => {
  assert.equal(perfil.validarPerfil({ regra: { limiarLiga: 30, bombaTurbo: true } }).ok, false);
  assert.equal(perfil.validarPerfil({ seguranca: { exigirAssinatura: false } }).ok, false);
  assert.equal(perfil.validarPerfil({ regra: { limiarLiga: 150 } }).ok, false);
  assert.equal(perfil.validarPerfil({}).ok, true);
});

test('combinacao incoerente (liga >= desliga) nao e aplicada', () => {
  const r = perfil.resolverPerfil(PADRAO,
    perfil.camadasDoCadastro(cadastro({ vaso_parametros: { regra: { limiarLiga: 70 } } })), {});
  assert.equal(r.ok, false);
  assert.match(r.erro, /limiarLiga/);
});

test('aplicarPerfil muda o cfg em lugar e devolve as mudancas; voltar ao padrao desfaz', () => {
  const cfg = { regra: { limiarLiga: 30, limiarDesliga: 50, duracaoPulsoMs: 3000, cooldownMs: 8000, validadeMs: 10000 },
    ambiente: { umidadeArMin: 50, histerese: 10 },
    adubacao: { ec25MinUsCm: 800, ec25MaxUsCm: 2000, umidadeMinPct: 35, maxDoses: 1, janelaDosesMs: 60000 } };
  const padrao = perfil.capturarPadrao(cfg);
  const regraOriginal = cfg.regra;

  const r = perfil.resolverPerfil(padrao, perfil.camadasDoCadastro(cadastro()), {});
  const mudancas = perfil.aplicarPerfil(cfg, r.valores);
  assert.equal(cfg.regra, regraOriginal, 'mesmo objeto: os modulos das regras enxergam a troca');
  assert.equal(cfg.regra.limiarLiga, 40);
  assert.equal(cfg.regra.validadeMs, 10000, 'chave fora do perfil nao e tocada');
  assert.ok(mudancas.find((m) => m.chave === 'regra.limiarLiga' && m.de === 30 && m.para === 40));

  const volta = perfil.resolverPerfil(padrao, perfil.camadasDoCadastro(null), {});
  perfil.aplicarPerfil(cfg, volta.valores);
  assert.equal(cfg.regra.limiarLiga, 30);
  assert.equal(cfg.ambiente.umidadeArMin, 50);
});

'use strict';
/*
 * R5 (luz) sem broker nem banco: media, histerese, tempo minimo e validade.
 * O tempo e passado como argumento -- nada aqui depende do relogio real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const contrato = require('../../contrato');
const { EstadoLuz, ESTADOS_LUZ } = require('../src/luz');

const base = contrato.carregarConfig();
const cfg = { ...base, luz: { luxMin: 300, luxMax: 20000, histerese: 0.2, amostrasMedia: 3, tempoMinimoMs: 10000, validadeMs: 30000 } };

let seq = 0;
const leitura = (lux, extra) => ({ eventId: `app-vaso-01:ab12:${++seq}`, deviceId: 'app-vaso-01', lux, valid: true, ...extra });

/* Aplica leituras espacadas de `passo` ms a partir de t0; devolve as transicoes. */
function serie(luz, valores, t0, passo) {
  const ts = [];
  valores.forEach((v, i) => {
    const t = luz.aplicar(leitura(v), t0 + i * passo);
    if (t) ts.push(t);
  });
  return ts;
}

test('primeira classificacao ADEQUADA so com a janela cheia', () => {
  const luz = new EstadoLuz(cfg);
  assert.equal(luz.aplicar(leitura(2000), 0), null);
  assert.equal(luz.aplicar(leitura(2000), 1000), null);
  const t = luz.aplicar(leitura(2000), 2000);
  assert.deepEqual([t.anterior, t.atual], [ESTADOS_LUZ.SEM_MEDICAO, ESTADOS_LUZ.ADEQUADA]);
});

test('pouca luz momentanea (mao sobre o sensor) NAO muda o estado', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [2000, 2000, 2000], 0, 1000);
  // 3 leituras escuras em 3 s, e a luz volta: menos que o tempo minimo.
  const ts = serie(luz, [5, 5, 5, 2000, 2000, 2000], 3000, 1000);
  assert.equal(ts.length, 0);
  assert.equal(luz.estado, ESTADOS_LUZ.ADEQUADA);
});

test('pouca luz SUSTENTADA vira POUCA_LUZ depois do tempo minimo', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [2000, 2000, 2000], 0, 1000);
  serie(luz, [5, 5, 5], 3000, 1000); // media < luxMin a partir daqui: candidato
  assert.equal(luz.estado, ESTADOS_LUZ.ADEQUADA);
  assert.equal(luz.avaliar(5000 + cfg.luz.tempoMinimoMs - 1), null);
  const t = luz.avaliar(5000 + cfg.luz.tempoMinimoMs);
  assert.equal(t.atual, ESTADOS_LUZ.POUCA_LUZ);
});

test('histerese: para sair de POUCA_LUZ a media precisa passar luxMin + margem', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [5, 5, 5], 0, 1000);
  luz.avaliar(2000 + cfg.luz.tempoMinimoMs);
  assert.equal(luz.estado, ESTADOS_LUZ.POUCA_LUZ);
  // 330 lux: acima de luxMin (300), mas abaixo de 300 * 1.2 = 360.
  serie(luz, [330, 330, 330], 20000, 1000);
  luz.avaliar(60000);
  assert.equal(luz.estado, ESTADOS_LUZ.POUCA_LUZ);
  serie(luz, [800, 800, 800], 61000, 1000);
  luz.avaliar(63000 + cfg.luz.tempoMinimoMs);
  assert.equal(luz.estado, ESTADOS_LUZ.ADEQUADA);
});

test('luz excessiva sustentada vira LUZ_EXCESSIVA', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [50000, 50000, 50000], 0, 1000);
  assert.equal(luz.estado, ESTADOS_LUZ.SEM_MEDICAO); // sem tempo minimo ainda
  assert.equal(luz.avaliar(2000 + cfg.luz.tempoMinimoMs).atual, ESTADOS_LUZ.LUZ_EXCESSIVA);
});

test('sem leitura pela validade: SEM_MEDICAO (silencio nao e luz adequada)', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [2000, 2000, 2000], 0, 1000);
  assert.equal(luz.expirarSeNecessario(2000 + cfg.luz.validadeMs - 1), null);
  const t = luz.expirarSeNecessario(2000 + cfg.luz.validadeMs);
  assert.equal(t.atual, ESTADOS_LUZ.SEM_MEDICAO);
  assert.equal(luz.media(), null);
});

test('leitura invalida do celular descarta a media', () => {
  const luz = new EstadoLuz(cfg);
  serie(luz, [2000, 2000, 2000], 0, 1000);
  const t = luz.aplicar({ ...leitura(0), valid: false, invalidReason: 'sensor_ausente' }, 4000);
  assert.equal(t.atual, ESTADOS_LUZ.SEM_MEDICAO);
  assert.equal(t.motivo, 'sensor_ausente');
  assert.equal(luz.media(), null);
});

test('contrato LeituraLuz: lux obrigatorio quando valida; faixa fisica', () => {
  const ok = {
    schemaVersion: 1, eventId: 'app-vaso-01:ab12:1', eventType: 'LeituraLuz', deviceId: 'app-vaso-01',
    entityId: 'vaso-01', sequence: 1, measuredAt: '2026-11-24T18:00:00.000Z', lux: 850, samples: 4,
    windowMs: 5000, sensor: 'TCS3701 Light', valid: true
  };
  assert.equal(contrato.validar('LeituraLuz', ok).ok, true);
  const { lux, ...semLux } = ok;
  assert.equal(contrato.validar('LeituraLuz', semLux).ok, false);
  assert.equal(contrato.validar('LeituraLuz', { ...semLux, valid: false, invalidReason: 'sensor_ausente' }).ok, true);
  assert.equal(contrato.validar('LeituraLuz', { ...ok, lux: -1 }).ok, false);
  assert.equal(contrato.validar('LeituraLuz', { ...ok, lux: 500000 }).ok, false);
});

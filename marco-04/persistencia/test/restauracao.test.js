'use strict';
/*
 * exportar()/restaurar() das regras do servico, sem banco nem broker: o que
 * sobrevive a um reinicio e o que, de proposito, nao sobrevive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const contrato = require('../../contrato');
const { EstadoVaso, ESTADOS } = require('../../consumidor-servico/src/estado');
const { VerificacaoIrrigacao } = require('../../consumidor-servico/src/verificacao');
const { RegraAdubacao, ESTADOS_ADUBO } = require('../../consumidor-servico/src/adubacao');
const { EstadoAmbiente } = require('../../consumidor-servico/src/ambiente');
const decisao = require('../../consumidor-servico/src/decisao');

const cfg = contrato.carregarConfig();
const logMudo = { registrar() {} };

function leitura(valor, seq) {
  return { eventId: `sim:abc:${seq}`, deviceId: 'sim-vaso-01', bootId: 'abc', eventTimeMs: seq * 1000, value: valor };
}

/* JSON ida e volta, como no banco (jsonb). */
const viaBanco = (x) => JSON.parse(JSON.stringify(x));

test('solo: AUTORIZADO nao e restaurado; dedup, cooldown e ultimo valor sim', () => {
  const agora = Date.now();
  const a = new EstadoVaso('vaso-01', cfg);
  for (let i = 1; i <= cfg.regra.amostrasDebounce; i++) a.aplicarLeitura(leitura(10, i), agora);
  a.registrarEventId('sim:abc:1');
  a.registrarEventId('sim:abc:2');
  a.ultimoComandoEm = agora - 1000;
  assert.equal(a.estado, ESTADOS.AUTORIZADO);

  const b = new EstadoVaso('vaso-01', cfg);
  const t = b.restaurar(viaBanco(a.exportar()));
  assert.equal(t.anterior, ESTADOS.AUTORIZADO);
  assert.equal(b.estado, ESTADOS.DADO_OBSOLETO, 'decidir sobre dado de antes do reinicio nao');
  assert.equal(b.autorizado(), false);
  assert.equal(b.emFalha(), true);
  assert.equal(b.consecutivasSecas, 0);
  assert.equal(b.ultimoValor, 10);
  assert.equal(b.ultimoComandoEm, agora - 1000, 'cooldown continua contando');
  assert.equal(b.jaVisto('sim:abc:2'), true, 'retry QoS 1 apos o reinicio continua DUPLICADO');
  assert.equal(b.jaVisto('sim:abc:99'), false);
  assert.equal(b.expirarSeNecessario(agora + 60000), null, 'nao gera expiracao falsa');
});

test('solo: sem leitura anterior volta DESCONHECIDO', () => {
  const b = new EstadoVaso('vaso-01', cfg);
  b.restaurar(viaBanco(new EstadoVaso('vaso-01', cfg).exportar()));
  assert.equal(b.estado, ESTADOS.DESCONHECIDO);
});

test('solo: a contagem de secas recomeca depois de restaurar', () => {
  const agora = Date.now();
  const b = new EstadoVaso('vaso-01', cfg);
  b.restaurar({ ultimoValor: 10, bootId: 'abc', deviceId: 'sim-vaso-01', eventIds: [] });
  const t = b.aplicarLeitura(leitura(10, 50), agora);
  assert.equal(t.descontinuidade, true);
  assert.equal(b.estado, cfg.regra.amostrasDebounce > 1 ? ESTADOS.AGUARDANDO : ESTADOS.AUTORIZADO);
});

test('verificacao: bloqueio sobrevive; verificacao em curso e descartada', () => {
  const agora = Date.now();
  const a = new VerificacaoIrrigacao(cfg);
  a.iniciar('cmd-000007', 20, 80, agora - 60000);
  a.avaliar(20, 80, agora); // estoura a janela -> bloqueia
  assert.equal(a.bloqueada(agora), true);

  const b = new VerificacaoIrrigacao(cfg);
  const notas = b.restaurar(viaBanco(a.exportar()));
  assert.equal(b.bloqueada(agora), true);
  assert.equal(b.diagnostico, 'bomba_sem_fluxo');
  assert.ok(notas.some((n) => n.includes('bloqueada')));

  const c = new VerificacaoIrrigacao(cfg);
  c.iniciar('cmd-000008', 20, 80, agora);
  const d = new VerificacaoIrrigacao(cfg);
  const notas2 = d.restaurar(viaBanco(c.exportar()));
  assert.equal(d.emCurso, null);
  assert.ok(notas2.some((n) => n.includes('descartada')));
});

function regraAdubacao() {
  return new RegraAdubacao(cfg, {
    estadoVaso: new EstadoVaso('vaso-01', cfg), reservatorios: {}, atuadores: {}, alertas: {}, log: logMudo,
    irrigacaoBloqueada: () => false
  });
}

test('adubacao: doses na janela sobrevivem (limite nao e burlado reiniciando)', () => {
  const agora = Date.now();
  const a = regraAdubacao();
  a.registrarDose(agora - 1000);
  const b = regraAdubacao();
  b.restaurar(viaBanco(a.exportar()), agora);
  assert.equal(b.dosesNaJanela(agora), 1);
  assert.equal(b.estado, ESTADOS_ADUBO.OCIOSO);
});

test('adubacao: DOSANDO com comando publicado conta a dose (suposicao segura)', () => {
  const agora = Date.now();
  const a = regraAdubacao();
  a.estado = ESTADOS_ADUBO.DOSANDO;
  a.comando = { commandId: 'atu-000004' };
  const b = regraAdubacao();
  const notas = b.restaurar(viaBanco(a.exportar()), agora);
  assert.equal(b.estado, ESTADOS_ADUBO.OCIOSO);
  assert.equal(b.dosesNaJanela(agora), 1);
  assert.equal(b.ultimaTentativaEm, agora, 'cooldown de tentativa reiniciado');
  assert.ok(notas.some((n) => n.includes('assumida como aplicada')));
});

test('adubacao: DOSANDO sem comando (nada saiu) nao conta dose', () => {
  const agora = Date.now();
  const a = regraAdubacao();
  a.estado = ESTADOS_ADUBO.DOSANDO;
  const b = regraAdubacao();
  b.restaurar(viaBanco(a.exportar()), agora);
  assert.equal(b.dosesNaJanela(agora), 0);
});

test('adubacao: BLOQUEADA continua bloqueada com o mesmo inicio', () => {
  const agora = Date.now();
  const a = regraAdubacao();
  a.estado = ESTADOS_ADUBO.BLOQUEADA;
  a.desde = agora - 5000;
  const b = regraAdubacao();
  b.restaurar(viaBanco(a.exportar()), agora);
  assert.equal(b.estado, ESTADOS_ADUBO.BLOQUEADA);
  assert.equal(b.desde, agora - 5000);
});

test('ambiente: umidificador volta desligado; tempo minimo entre trocas preservado', () => {
  const a = new EstadoAmbiente(cfg);
  a.umidificadorLigado = true;
  a.ultimaMudancaEm = 12345;
  const b = new EstadoAmbiente(cfg);
  b.restaurar(viaBanco(a.exportar()));
  assert.equal(b.umidificadorLigado, false);
  assert.equal(b.ultimaMudancaEm, 12345);
});

test('contador de comandos nao volta para tras', () => {
  decisao.restaurarContador(41);
  assert.equal(decisao.contadorAtual(), 41);
  decisao.restaurarContador(3);
  assert.equal(decisao.contadorAtual(), 41);
});

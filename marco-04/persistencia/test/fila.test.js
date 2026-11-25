'use strict';
/*
 * Fila de gravacao da Persistencia, sem banco: o executor e falso e pode
 * "cair" e "voltar". Cobre: enfileira com o banco fora, despeja na volta,
 * limite da fila, linha ruim nao trava a fila, snapshot pendente, desabilitada.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Persistencia, erroDeConexao } = require('..');

function bancoFalso() {
  const b = { fora: false, linhas: [], estados: new Map(), rejeitar: null };
  b.executor = async (sql, params) => {
    if (b.fora) {
      const e = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      e.code = 'ECONNREFUSED';
      throw e;
    }
    if (sql.startsWith('INSERT INTO estado_servico')) {
      b.estados.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO')) {
      if (b.rejeitar && b.rejeitar(params)) {
        const e = new Error('value too long');
        e.code = '22001';
        throw e;
      }
      b.linhas.push({ tabela: sql.split(' ')[2], params });
    }
    return { rows: [] };
  };
  return b;
}

function cfgTeste(extras) {
  return {
    identidade: { vasoId: 'vaso-01' },
    persistencia: { habilitada: 1, filaMax: 5, esperaPartidaMs: 0, ...(extras || {}) }
  };
}

async function criar(banco, extras) {
  const p = new Persistencia(cfgTeste(extras), { executor: banco.executor, migrar: async () => banco.executor('SELECT 1') });
  await p.iniciar();
  return p;
}

const tique = () => new Promise((r) => setTimeout(r, 20));

test('grava com o banco no ar e preenche id, ts e vaso_id', async () => {
  const banco = bancoFalso();
  const p = await criar(banco);
  p.gravar('alertas', { event_id: 'e1', tipo: 'SOLO_SECO', severidade: 'ATENCAO', mensagem: 'm' });
  await p.despejar();
  assert.equal(banco.linhas.length, 1);
  assert.equal(p.status().fila, 0);
  const sql = banco.linhas[0];
  assert.equal(sql.tabela, 'alertas');
  assert.match(sql.params[0], /^[0-9a-f-]{36}$/); // id
  assert.ok(sql.params[1] instanceof Date); // ts
  assert.equal(sql.params[2], 'vaso-01');
  await p.fechar();
});

test('banco fora: enfileira sem lancar; na volta despeja tudo em ordem', async () => {
  const banco = bancoFalso();
  const p = await criar(banco);
  banco.fora = true;
  for (let i = 1; i <= 3; i++) p.gravar('transicoes', { componente: 'solo', atual: `E${i}` });
  await p.despejar();
  assert.equal(p.status().conectado, false);
  assert.equal(p.status().fila, 3);
  assert.equal(p.status().quedas, 1);

  banco.fora = false;
  await p.despejar();
  assert.equal(p.status().conectado, true);
  assert.equal(p.status().fila, 0);
  assert.deepEqual(banco.linhas.map((l) => l.params[4]), ['E1', 'E2', 'E3']);
  await p.fechar();
});

test('fila cheia descarta as gravacoes MAIS ANTIGAS e conta', async () => {
  const banco = bancoFalso();
  const p = await criar(banco, { filaMax: 3 });
  banco.fora = true;
  await p.despejar();
  for (let i = 1; i <= 5; i++) p.gravar('transicoes', { componente: 'solo', atual: `E${i}` });
  assert.equal(p.status().fila, 3);
  assert.equal(p.status().descartadasFilaCheia, 2);
  banco.fora = false;
  await p.despejar();
  assert.deepEqual(banco.linhas.map((l) => l.params[4]), ['E3', 'E4', 'E5']);
  await p.fechar();
});

test('erro de DADO descarta so a linha ruim; a fila segue', async () => {
  const banco = bancoFalso();
  banco.rejeitar = (params) => params.includes('RUIM');
  const p = await criar(banco);
  p.gravar('transicoes', { componente: 'solo', atual: 'OK1' });
  p.gravar('transicoes', { componente: 'solo', atual: 'RUIM' });
  p.gravar('transicoes', { componente: 'solo', atual: 'OK2' });
  await p.despejar();
  assert.deepEqual(banco.linhas.map((l) => l.params[4]), ['OK1', 'OK2']);
  assert.equal(p.status().rejeitadas, 1);
  assert.equal(p.status().conectado, true);
  await p.fechar();
});

test('snapshot de estado: so o mais recente e escrito, inclusive depois de uma queda', async () => {
  const banco = bancoFalso();
  const p = await criar(banco);
  banco.fora = true;
  p.salvarEstado('vaso:vaso-01', { n: 1 });
  p.salvarEstado('vaso:vaso-01', { n: 2 });
  await p.despejar();
  assert.equal(banco.estados.size, 0);
  banco.fora = false;
  await p.despejar();
  assert.deepEqual(banco.estados.get('vaso:vaso-01'), { n: 2 });
  await p.fechar();
});

test('tabela fora da lista e recusada (nao vira SQL)', async () => {
  const p = await criar(bancoFalso());
  assert.throws(() => p.gravar('usuarios; DROP TABLE x', {}), /tabela desconhecida/);
  await p.fechar();
});

test('desabilitada: nao grava nada e nao tenta conectar', async () => {
  const banco = bancoFalso();
  const p = new Persistencia(cfgTeste({ habilitada: 0 }), { executor: banco.executor });
  assert.equal(await p.iniciar(), false);
  p.gravar('alertas', { event_id: 'x' });
  await tique();
  assert.equal(p.status().fila, 0);
  assert.equal(banco.linhas.length, 0);
});

test('classificacao de erros: conexao re-tenta, dado descarta', () => {
  assert.equal(erroDeConexao({ code: 'ECONNREFUSED' }), true);
  assert.equal(erroDeConexao({ code: '57P01' }), true); // admin_shutdown
  assert.equal(erroDeConexao({ code: '08006' }), true); // connection_failure
  assert.equal(erroDeConexao(new Error('timeout')), true);
  assert.equal(erroDeConexao({ code: '23505' }), false); // unique_violation
  assert.equal(erroDeConexao({ code: '22001' }), false);
});

'use strict';
/*
 * Log do consumidor: duas saidas com finalidades distintas.
 *
 *   - CONSOLE: legivel na apresentacao, uma linha por etapa do pipeline.
 *   - JSONL:   um objeto por linha, para reconstruir a cadeia da decisao depois.
 *
 * O requisito que isso atende esta no roteiro da aula: "os logs permitem
 * reconstruir a decisao?". Cada linha registra a etapa, o eventId e o motivo --
 * de modo que seja possivel responder POR QUE o servico decidiu o que decidiu,
 * e nao apenas O QUE ele decidiu.
 */

const fs = require('fs');
const path = require('path');

const CORES = {
  reset: '\x1b[0m',
  cinza: '\x1b[90m',
  vermelho: '\x1b[31m',
  verde: '\x1b[32m',
  amarelo: '\x1b[33m',
  azul: '\x1b[36m',
  negrito: '\x1b[1m'
};

const ETAPAS = {
  RECEBIDO: { cor: CORES.cinza, rotulo: 'RECEBIDO' },
  REJEITADO: { cor: CORES.vermelho, rotulo: 'REJEITADO' },
  DUPLICADO: { cor: CORES.amarelo, rotulo: 'DUPLICADO' },
  HISTORICO: { cor: CORES.cinza, rotulo: 'HISTORICO' },
  ACEITO: { cor: CORES.azul, rotulo: 'ACEITO' },
  ESTADO: { cor: CORES.negrito, rotulo: 'ESTADO' },
  DECISAO: { cor: CORES.verde, rotulo: 'DECISAO' },
  SEM_ACAO: { cor: CORES.cinza, rotulo: 'SEM_ACAO' },
  COMANDO: { cor: CORES.verde, rotulo: 'COMANDO' },
  ACK: { cor: CORES.azul, rotulo: 'ACK' },
  CONEXAO: { cor: CORES.amarelo, rotulo: 'CONEXAO' }
};

class Log {
  constructor(caminhoJsonl) {
    this.caminho = caminhoJsonl;
    if (this.caminho) {
      fs.mkdirSync(path.dirname(this.caminho), { recursive: true });
      // 'a': o arquivo e um historico, nao um espelho da execucao atual.
      this.fluxo = fs.createWriteStream(this.caminho, { flags: 'a' });
    }
  }

  registrar(etapa, mensagem, dados) {
    const marca = new Date().toISOString();
    const meta = ETAPAS[etapa] || { cor: CORES.reset, rotulo: etapa };

    console.log(
      `${CORES.cinza}${marca.slice(11, 23)}${CORES.reset} ` +
        `${meta.cor}${meta.rotulo.padEnd(10)}${CORES.reset} ${mensagem}`
    );

    if (this.fluxo) {
      this.fluxo.write(
        JSON.stringify({ ts: marca, etapa, mensagem, ...(dados || {}) }) + '\n'
      );
    }
  }

  fechar() {
    if (this.fluxo) this.fluxo.end();
  }
}

module.exports = { Log, CORES };

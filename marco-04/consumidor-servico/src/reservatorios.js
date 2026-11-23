'use strict';
/*
 * Marco 4 -- R4: nivel dos reservatorios de agua e de fertilizante.
 *
 * O dispositivo entrega a mediana da distancia e o nivel em %. Aqui ficam os
 * estados com histerese e a validade:
 *
 *   OK (> baixo) / BAIXO (<= baixo) / CRITICO (<= critico)
 *   Para SAIR de um estado pior, o nivel precisa passar o limiar + histerese.
 *
 * CRITICO bloqueia a bomba correspondente aqui (o servico nao pede o que sabe
 * ser impossivel) e TAMBEM no dispositivo (que nao executa). A protecao fisica
 * e a do dispositivo: e ele que tem o sensor e sofre a consequencia. Por isso,
 * com dado obsoleto o servico fica em DESCONHECIDO e NAO bloqueia sozinho --
 * quem barra uma bomba a seco e o firmware.
 */

const ESTADOS_NIVEL = {
  DESCONHECIDO: 'DESCONHECIDO',
  OK: 'OK',
  BAIXO: 'BAIXO',
  CRITICO: 'CRITICO',
  INVALIDO: 'INVALIDO'
};

class EstadoReservatorios {
  constructor(cfg) {
    this.cfg = cfg;
    this.niveis = {};
    for (const r of ['AGUA', 'ADUBO']) {
      this.niveis[r] = {
        estado: ESTADOS_NIVEL.DESCONHECIDO,
        levelPct: null,
        recebidoEm: null,
        visto: false, // ja houve telemetria deste reservatorio neste servico?
        ultimoEventId: null
      };
    }
  }

  aplicar(payload, agora) {
    const n = this.niveis[payload.reservoir];
    const anterior = n.estado;
    n.visto = true;
    n.recebidoEm = agora;
    n.ultimoEventId = payload.eventId;

    if (payload.valid === false) {
      n.estado = ESTADOS_NIVEL.INVALIDO;
      return { reservatorio: payload.reservoir, anterior, atual: n.estado, motivo: payload.invalidReason || 'invalido' };
    }
    n.levelPct = payload.levelPct;
    n.estado = this.calcular(anterior, payload.levelPct);
    return { reservatorio: payload.reservoir, anterior, atual: n.estado };
  }

  calcular(anterior, nivel) {
    const r = this.cfg.reservatorios;
    const sairCritico = r.nivelCriticoPct + r.histeresePct;
    const sairBaixo = r.nivelBaixoPct + r.histeresePct;
    if (anterior === ESTADOS_NIVEL.CRITICO) {
      if (nivel > sairBaixo) return ESTADOS_NIVEL.OK;
      if (nivel > sairCritico) return ESTADOS_NIVEL.BAIXO;
      return ESTADOS_NIVEL.CRITICO;
    }
    if (anterior === ESTADOS_NIVEL.BAIXO) {
      if (nivel <= r.nivelCriticoPct) return ESTADOS_NIVEL.CRITICO;
      if (nivel > sairBaixo) return ESTADOS_NIVEL.OK;
      return ESTADOS_NIVEL.BAIXO;
    }
    if (nivel <= r.nivelCriticoPct) return ESTADOS_NIVEL.CRITICO;
    if (nivel <= r.nivelBaixoPct) return ESTADOS_NIVEL.BAIXO;
    return ESTADOS_NIVEL.OK;
  }

  /* Devolve as transicoes por validade vencida (uma por reservatorio). */
  expirarSeNecessario(agora) {
    const transicoes = [];
    for (const [nome, n] of Object.entries(this.niveis)) {
      if (n.recebidoEm === null || n.estado === ESTADOS_NIVEL.DESCONHECIDO) continue;
      if (agora - n.recebidoEm >= this.cfg.reservatorios.validadeMs) {
        transicoes.push({ reservatorio: nome, anterior: n.estado, atual: ESTADOS_NIVEL.DESCONHECIDO, motivo: 'validade_expirada' });
        n.estado = ESTADOS_NIVEL.DESCONHECIDO;
      }
    }
    return transicoes;
  }

  critico(reservatorio) {
    return this.niveis[reservatorio].estado === ESTADOS_NIVEL.CRITICO;
  }

  /* Nivel atual so se for confiavel (OK/BAIXO/CRITICO); senao null. */
  nivelConfiavel(reservatorio) {
    const n = this.niveis[reservatorio];
    const ok = [ESTADOS_NIVEL.OK, ESTADOS_NIVEL.BAIXO, ESTADOS_NIVEL.CRITICO].includes(n.estado);
    return ok ? n.levelPct : null;
  }

  visto(reservatorio) {
    return this.niveis[reservatorio].visto;
  }

  resumo() {
    const r = {};
    for (const [nome, n] of Object.entries(this.niveis)) r[nome] = { estado: n.estado, nivelPct: n.levelPct };
    return r;
  }
}

module.exports = { EstadoReservatorios, ESTADOS_NIVEL };

'use strict';
/*
 * Marco 4 -- R5: luz no lugar do vaso, medida pelo sensor do CELULAR.
 *
 * O app e o produtor (LeituraLuz em telemetry/light); o estado e a decisao
 * ficam aqui, como nas outras regras. Regra com ESTADO e TEMPO:
 *
 *   - media movel de amostrasMedia leituras (uma leitura isolada nao decide);
 *   - faixas com histerese: POUCA_LUZ abaixo de luxMin, LUZ_EXCESSIVA acima de
 *     luxMax; para sair de uma faixa, a media precisa passar a margem
 *     (histerese, em fracao do limiar);
 *   - TEMPO MINIMO: a faixa nova so vale depois de se manter por tempoMinimoMs.
 *     Tampar o sensor com a mao, passar uma sombra ou acender a lanterna por um
 *     instante nao muda nada -- a planta sofre com luz sustentada, nao com um
 *     segundo;
 *   - VALIDADE: sem leitura por validadeMs (app fechado, celular saiu de perto),
 *     o estado vira SEM_MEDICAO. Silencio nao e "luz adequada".
 *
 * Nao ha atuador de luz (lampada, cortina): a resposta e o alerta para o usuario
 * mover o vaso. E o uso previsto desde o Marco 4 (docs/marco-04.md, secao 9).
 */

const ESTADOS_LUZ = {
  SEM_MEDICAO: 'SEM_MEDICAO',
  ADEQUADA: 'ADEQUADA',
  POUCA_LUZ: 'POUCA_LUZ',
  LUZ_EXCESSIVA: 'LUZ_EXCESSIVA'
};

class EstadoLuz {
  constructor(cfg) {
    this.cfg = cfg;
    this.estado = ESTADOS_LUZ.SEM_MEDICAO;
    this.janela = [];
    this.recebidoEm = null;
    this.deviceId = null;
    this.ultimoEventId = null;
    this.candidato = null; // { estado, desde }: faixa nova esperando o tempo minimo
  }

  media() {
    if (this.janela.length === 0) return null;
    return this.janela.reduce((s, v) => s + v, 0) / this.janela.length;
  }

  /* Faixa da media, com histerese em torno da faixa ATUAL. */
  faixa(m) {
    const l = this.cfg.luz;
    const h = l.histerese;
    if (this.estado === ESTADOS_LUZ.POUCA_LUZ && m < l.luxMin * (1 + h)) return ESTADOS_LUZ.POUCA_LUZ;
    if (this.estado === ESTADOS_LUZ.LUZ_EXCESSIVA && m > l.luxMax * (1 - h)) return ESTADOS_LUZ.LUZ_EXCESSIVA;
    if (m < l.luxMin) return ESTADOS_LUZ.POUCA_LUZ;
    if (m > l.luxMax) return ESTADOS_LUZ.LUZ_EXCESSIVA;
    return ESTADOS_LUZ.ADEQUADA;
  }

  /*
   * Aplica uma LeituraLuz ja validada (contrato, deduplicacao e atraso ficam no
   * main.js). Devolve a transicao, se houve.
   */
  aplicar(payload, agora) {
    this.recebidoEm = agora;
    this.deviceId = payload.deviceId;
    this.ultimoEventId = payload.eventId;
    if (payload.valid === false) {
      // O celular disse que nao conseguiu medir: a media antiga deixa de valer.
      this.janela = [];
      this.candidato = null;
      return this.mudar(ESTADOS_LUZ.SEM_MEDICAO, payload.invalidReason || 'leitura_invalida');
    }
    this.janela.push(payload.lux);
    while (this.janela.length > this.cfg.luz.amostrasMedia) this.janela.shift();
    return this.avaliar(agora);
  }

  /* Chamado a cada leitura e pelo tick: o tempo minimo vence sem mensagem nova. */
  avaliar(agora) {
    if (this.janela.length < this.cfg.luz.amostrasMedia) return null;
    const alvo = this.faixa(this.media());
    if (alvo === this.estado) {
      this.candidato = null;
      return null;
    }
    // Primeira classificacao depois de SEM_MEDICAO: nao ha faixa anterior a
    // proteger de oscilacao, mas POUCA/EXCESSIVA ainda exigem o tempo minimo
    // (sao elas que viram alerta).
    if (this.estado === ESTADOS_LUZ.SEM_MEDICAO && alvo === ESTADOS_LUZ.ADEQUADA) {
      this.candidato = null;
      return this.mudar(alvo, 'primeira_medicao');
    }
    if (!this.candidato || this.candidato.estado !== alvo) {
      this.candidato = { estado: alvo, desde: agora };
      return null;
    }
    if (agora - this.candidato.desde < this.cfg.luz.tempoMinimoMs) return null;
    const sustentado = agora - this.candidato.desde;
    this.candidato = null;
    return this.mudar(alvo, `media_sustentada_${Math.round(sustentado / 1000)}s`);
  }

  expirarSeNecessario(agora) {
    if (this.recebidoEm === null || this.estado === ESTADOS_LUZ.SEM_MEDICAO) return null;
    if (agora - this.recebidoEm < this.cfg.luz.validadeMs) return null;
    this.janela = [];
    this.candidato = null;
    return this.mudar(ESTADOS_LUZ.SEM_MEDICAO, 'validade_expirada');
  }

  mudar(atual, motivo) {
    const anterior = this.estado;
    if (anterior === atual) return null;
    this.estado = atual;
    return { anterior, atual, motivo };
  }

  idadeMs(agora) {
    return this.recebidoEm === null ? null : agora - this.recebidoEm;
  }

  resumo(agora) {
    const m = this.media();
    return {
      estado: this.estado,
      luxMedia: m === null ? null : Math.round(m),
      idadeMs: this.idadeMs(agora),
      deviceId: this.deviceId,
      candidato: this.candidato ? this.candidato.estado : null
    };
  }
}

module.exports = { EstadoLuz, ESTADOS_LUZ };

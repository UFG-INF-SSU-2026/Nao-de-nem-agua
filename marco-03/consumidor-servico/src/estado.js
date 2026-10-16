'use strict';
/*
 * Estado temporal do consumidor.
 *
 * Origem: recorte "estado temporal e resiliencia" do Marco 1 (controle.h).
 * A maquina de estados daquele prototipo foi transposta do firmware para o
 * servico, porque na arquitetura da Atividade 02 (itens 10 e 11) o estado da
 * janela e a decisao pertencem a nuvem, nao ao dispositivo.
 *
 * O que mudou ao atravessar a fronteira:
 *
 * 1. A IDADE do dado passa a ser medida pelo relogio DO CONSUMIDOR, no instante
 *    de recepcao. O dispositivo nao tem NTP (limitacao herdada do Marco 1), e
 *    seu eventTimeMs e relativo ao boot -- portanto nao serve para calcular
 *    idade aqui. O eventTimeMs continua sendo carregado e registrado, mas como
 *    tempo do evento no dominio do dispositivo.
 *
 * 2. Trocar de bootId significa que o dispositivo reiniciou: sequence e
 *    eventTimeMs voltaram a zero. O estado anterior nao pode ser comparado com
 *    o novo, e por isso e descartado explicitamente.
 *
 * 3. Existe um estado novo, DISPOSITIVO_OFFLINE, que nao existia no prototipo
 *    individual: ele so e alcancavel porque agora ha uma rede que pode cair.
 */

const ESTADOS = {
  DESCONHECIDO: 'DESCONHECIDO',
  NORMAL: 'NORMAL',
  AGUARDANDO: 'AGUARDANDO',
  AUTORIZADO: 'AUTORIZADO',
  DADO_OBSOLETO: 'DADO_OBSOLETO',
  LEITURA_INVALIDA: 'LEITURA_INVALIDA',
  DISPOSITIVO_OFFLINE: 'DISPOSITIVO_OFFLINE'
};

/* Estados em que NENHUMA atuacao pode ser autorizada. */
const ESTADOS_DE_FALHA = new Set([
  ESTADOS.DESCONHECIDO,
  ESTADOS.DADO_OBSOLETO,
  ESTADOS.LEITURA_INVALIDA,
  ESTADOS.DISPOSITIVO_OFFLINE
]);

const LIMITE_EVENT_IDS = 500;

class EstadoVaso {
  constructor(vasoId, cfg) {
    this.vasoId = vasoId;
    this.cfg = cfg;

    this.estado = ESTADOS.DESCONHECIDO;
    this.bootId = null;

    this.ultimoValor = null;
    this.ultimoEventId = null;
    this.ultimoEventTimeMs = null;
    this.recebidoEm = null; // relogio do consumidor: base da idade

    this.consecutivasSecas = 0;
    this.bombaLigada = false;
    this.ultimoComandoEm = null;

    // Deduplicacao por eventId. Conjunto limitado: o servico nao pode crescer
    // sem limite so porque o dispositivo ficou ligado muito tempo.
    this.eventIdsVistos = new Set();
    this.ordemEventIds = [];
  }

  /* Deduplicacao (Atividade 02, item 4: reenvio por retry nao reprocessa). */
  jaVisto(eventId) {
    return this.eventIdsVistos.has(eventId);
  }

  registrarEventId(eventId) {
    this.eventIdsVistos.add(eventId);
    this.ordemEventIds.push(eventId);
    if (this.ordemEventIds.length > LIMITE_EVENT_IDS) {
      this.eventIdsVistos.delete(this.ordemEventIds.shift());
    }
  }

  /* Idade do dado corrente, no relogio do consumidor. */
  idadeMs(agora) {
    if (this.recebidoEm === null) return null;
    return agora - this.recebidoEm;
  }

  /*
   * Expiracao da validade. Roda a cada tick, INDEPENDENTEMENTE de chegar
   * telemetria nova -- e esse o ponto central do recorte de origem: se a
   * expiracao so fosse verificada quando um dado chega, um dispositivo mudo
   * manteria a autorizacao para sempre.
   */
  expirarSeNecessario(agora) {
    if (this.estado === ESTADOS.DISPOSITIVO_OFFLINE) return null;
    if (this.recebidoEm === null) return null;
    if (this.estado === ESTADOS.DADO_OBSOLETO) return null;

    if (this.idadeMs(agora) >= this.cfg.regra.validadeMs) {
      const anterior = this.estado;
      // O ultimo valor e PRESERVADO para diagnostico, mas deixa de autorizar
      // qualquer atuacao. Guardar o valor e afirmar que ele e atual sao coisas
      // diferentes.
      this.estado = ESTADOS.DADO_OBSOLETO;
      this.consecutivasSecas = 0;
      return { anterior, atual: this.estado, motivo: 'validade_expirada' };
    }
    return null;
  }

  /* LWT ou heartbeat OFFLINE: o dispositivo caiu. */
  marcarOffline(motivo) {
    const anterior = this.estado;
    this.estado = ESTADOS.DISPOSITIVO_OFFLINE;
    this.consecutivasSecas = 0;
    return { anterior, atual: this.estado, motivo };
  }

  /* Leitura recusada pela validacao local do dispositivo (valid: false). */
  marcarLeituraInvalida(motivo) {
    const anterior = this.estado;
    this.estado = ESTADOS.LEITURA_INVALIDA;
    this.consecutivasSecas = 0;
    return { anterior, atual: this.estado, motivo };
  }

  /*
   * Aplica uma telemetria valida e recalcula o estado.
   *
   * A contagem de amostras secas consecutivas nao sobrevive a uma interrupcao:
   * se o dado anterior venceu, ou se a leitura anterior foi invalida, a
   * contagem reinicia. Retomar a contagem de antes da interrupcao equivaleria a
   * decidir com um historico que nao se pode mais sustentar.
   */
  aplicarLeitura(evento, agora) {
    const anterior = this.estado;

    const houveDescontinuidade =
      this.bootId !== evento.bootId ||
      this.estado === ESTADOS.DADO_OBSOLETO ||
      this.estado === ESTADOS.LEITURA_INVALIDA ||
      this.estado === ESTADOS.DISPOSITIVO_OFFLINE ||
      this.estado === ESTADOS.DESCONHECIDO;

    if (houveDescontinuidade) this.consecutivasSecas = 0;

    this.bootId = evento.bootId;
    this.ultimoValor = evento.value;
    this.ultimoEventId = evento.eventId;
    this.ultimoEventTimeMs = evento.eventTimeMs;
    this.recebidoEm = agora;

    if (evento.value < this.cfg.regra.limiarLiga) {
      if (this.consecutivasSecas < this.cfg.regra.amostrasDebounce) {
        this.consecutivasSecas += 1;
      }
      this.estado =
        this.consecutivasSecas >= this.cfg.regra.amostrasDebounce
          ? ESTADOS.AUTORIZADO
          : ESTADOS.AGUARDANDO;
    } else {
      this.consecutivasSecas = 0;
      this.estado = ESTADOS.NORMAL;
    }

    return { anterior, atual: this.estado, descontinuidade: houveDescontinuidade };
  }

  autorizado() {
    return this.estado === ESTADOS.AUTORIZADO;
  }

  emFalha() {
    return ESTADOS_DE_FALHA.has(this.estado);
  }

  resumo(agora) {
    return {
      vasoId: this.vasoId,
      estado: this.estado,
      bootId: this.bootId,
      valor: this.ultimoValor,
      idadeMs: this.idadeMs(agora),
      consecutivasSecas: this.consecutivasSecas,
      bombaLigada: this.bombaLigada,
      autorizado: this.autorizado()
    };
  }
}

module.exports = { EstadoVaso, ESTADOS, ESTADOS_DE_FALHA };

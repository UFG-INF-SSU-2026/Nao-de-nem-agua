'use strict';
/*
 * Marco 4 -- R1: umidade do ar -> umidificador.
 *
 * Mesma divisao de responsabilidades do Marco 3: o dispositivo le o DHT22,
 * valida a leitura e publica LeituraAmbiente; o ESTADO (media movel, validade)
 * e a DECISAO ficam aqui.
 *
 * O LIGAR do umidificador e uma CONCESSAO com prazo (durationMs). O dispositivo
 * desliga sozinho quando a concessao vence, e o servico a renova enquanto a
 * condicao continuar. E a versao para um atuador continuo do "silencio nao e
 * normalidade": se o servico cair, o broker cair ou o dado parar de chegar, o
 * umidificador nao fica ligado para sempre.
 */

const ESTADOS_AR = {
  DESCONHECIDO: 'DESCONHECIDO',
  NORMAL: 'NORMAL',
  INVALIDO: 'INVALIDO',
  OBSOLETO: 'OBSOLETO'
};

class EstadoAmbiente {
  constructor(cfg) {
    this.cfg = cfg;
    this.estado = ESTADOS_AR.DESCONHECIDO;
    this.janela = [];
    this.ultimo = null; // ultimo payload valido (temperatura, umidade, eventId)
    this.ultimoEventId = null;
    this.ultimoEventTimeMs = null;
    this.deviceId = null;
    this.recebidoEm = null;

    this.umidificadorLigado = false; // intencao, como bombaLigada no Marco 3
    this.ultimaMudancaEm = null; // ultima troca LIGAR <-> DESLIGAR
    this.ultimaConcessaoEm = null; // ultimo LIGAR (inclusive renovacao)
  }

  /* Aplica uma LeituraAmbiente ja validada pelo contrato. */
  aplicar(payload, agora) {
    const anterior = this.estado;
    this.deviceId = payload.deviceId;
    this.ultimoEventId = payload.eventId;
    this.ultimoEventTimeMs = payload.eventTimeMs;
    this.recebidoEm = agora;

    if (payload.valid === false) {
      // Leitura recusada pelo proprio dispositivo: nao entra na media, e a
      // media antiga deixa de valer -- decidir com ela seria decidir com dado
      // de antes da falha.
      this.estado = ESTADOS_AR.INVALIDO;
      this.janela = [];
    } else {
      this.ultimo = payload;
      this.janela.push(payload.humidityPct);
      while (this.janela.length > this.cfg.ambiente.amostrasMedia) this.janela.shift();
      this.estado = ESTADOS_AR.NORMAL;
    }
    return { anterior, atual: this.estado, motivo: payload.invalidReason || null };
  }

  /* Validade por tempo, no relogio do servico (igual a do solo). */
  expirarSeNecessario(agora) {
    if (this.recebidoEm === null || this.estado === ESTADOS_AR.OBSOLETO) return null;
    if (agora - this.recebidoEm < this.cfg.ambiente.validadeMs) return null;
    const anterior = this.estado;
    this.estado = ESTADOS_AR.OBSOLETO;
    this.janela = [];
    return { anterior, atual: this.estado, motivo: 'validade_expirada' };
  }

  media() {
    if (this.janela.length === 0) return null;
    return this.janela.reduce((s, v) => s + v, 0) / this.janela.length;
  }

  emFalha() {
    return this.estado !== ESTADOS_AR.NORMAL;
  }

  /*
   * Marco 4 -- persistencia. So o instante da ultima troca (tempo minimo entre
   * trocas do rele). O umidificador volta como DESLIGADO: a concessao vence
   * sozinha no dispositivo, e o servico renova se o ar continuar seco.
   */
  exportar() {
    return { ultimaMudancaEm: this.ultimaMudancaEm, umidificadorLigado: this.umidificadorLigado };
  }

  restaurar(s) {
    if (!s) return;
    this.ultimaMudancaEm = s.ultimaMudancaEm ?? null;
    this.umidificadorLigado = false;
    this.ultimaConcessaoEm = null;
  }

  resumo() {
    const m = this.media();
    return {
      estado: this.estado,
      umidadeArMedia: m === null ? null : Number(m.toFixed(1)),
      temperatura: this.ultimo ? this.ultimo.temperatureC : null,
      umidificadorLigado: this.umidificadorLigado
    };
  }
}

/*
 * Regra pura: devolve { acao, motivo } ou { acao: null, motivo } -- quem publica
 * e o main.js. Mesmo formato do decidir() do Marco 3.
 */
function decidirUmidificador(amb, cfg, agora) {
  const a = cfg.ambiente;

  // Sem dado confiavel do ar, o lado seguro e desligado.
  if (amb.emFalha()) {
    if (amb.umidificadorLigado) return { acao: 'DESLIGAR', motivo: `sensor_ar_${amb.estado.toLowerCase()}` };
    return { acao: null, motivo: `sensor_ar_${amb.estado.toLowerCase()}` };
  }
  if (amb.janela.length < a.amostrasMedia) return { acao: null, motivo: 'amostras_insuficientes' };

  const m = amb.media();
  const tempoMinimoOk = amb.ultimaMudancaEm === null || agora - amb.ultimaMudancaEm >= a.tempoMinimoMs;

  if (!amb.umidificadorLigado) {
    if (m < a.umidadeArMin) {
      return tempoMinimoOk
        ? { acao: 'LIGAR', motivo: 'umidade_ar_abaixo_minimo' }
        : { acao: null, motivo: 'tempo_minimo_desligado' };
    }
    return { acao: null, motivo: 'umidade_ar_ok' };
  }

  // Ligado: histerese -- so desliga acima de minimo + histerese.
  if (m > a.umidadeArMin + a.histerese) {
    return tempoMinimoOk
      ? { acao: 'DESLIGAR', motivo: 'umidade_ar_atingiu_alvo' }
      : { acao: null, motivo: 'tempo_minimo_ligado' };
  }
  // Ainda precisa: renova a concessao antes que ela venca no dispositivo.
  if (agora - amb.ultimaConcessaoEm >= a.concessaoMs / 2) {
    return { acao: 'LIGAR', motivo: 'renovacao_concessao' };
  }
  return { acao: null, motivo: 'dentro_da_histerese' };
}

module.exports = { EstadoAmbiente, decidirUmidificador, ESTADOS_AR };

'use strict';
/*
 * Marco 4 -- R2: verificacao do EFEITO da irrigacao.
 *
 * O Marco 3 ja distinguia entrega (PUBACK) de decisao do dispositivo (ack
 * EXECUTADO). O Marco 4 acrescenta a terceira pergunta: a agua chegou ao vaso?
 * Com o sensor de nivel, ela passa a ter resposta, por VALIDACAO CRUZADA entre
 * dois sensores independentes:
 *
 *   umidade do solo subiu  E  nivel do reservatorio de agua caiu  -> efeito confirmado
 *   nada mudou                                                     -> bomba sem fluxo
 *   nivel caiu, umidade nao                                        -> agua nao chegou ao vaso
 *   umidade subiu, nivel nao                                       -> sensor de nivel suspeito
 *
 * Sem efeito confirmado no prazo, a irrigacao automatica fica BLOQUEADA ate
 * reconhecimento (tecla 'r' no servico) ou ate bloqueioMs: ligar de novo uma
 * bomba que nao bombeia so a queima.
 *
 * So existe quando o vaso publica nivel de reservatorio. Um gateway do Marco 3
 * (sem sensor de nivel) continua funcionando exatamente como antes.
 */

class VerificacaoIrrigacao {
  constructor(cfg) {
    this.cfg = cfg;
    this.emCurso = null; // { commandId, umidAntes, nivelAntes, inicio }
    this.bloqueadaDesde = null;
    this.diagnostico = null;
  }

  /* Chamado quando o ack EXECUTADO de um PULSO_IRRIGACAO chega. */
  iniciar(commandId, umidAntes, nivelAntes, agora) {
    if (this.emCurso || umidAntes === null || nivelAntes === null) return false;
    this.emCurso = { commandId, umidAntes, nivelAntes, inicio: agora };
    return true;
  }

  /*
   * Avalia com os valores correntes. Devolve:
   *   null                                    nada mudou
   *   { resultado: 'CONFIRMADO', ... }        efeito confirmado
   *   { resultado: 'FALHOU', diagnostico }    prazo estourou -> bloqueia
   */
  avaliar(umidadeAtual, nivelAtual, agora) {
    if (!this.emCurso) return null;
    const v = this.cfg.verificacao;
    const c = this.emCurso;
    const umidSubiu = umidadeAtual !== null && umidadeAtual >= c.umidAntes + v.deltaUmidadePct;
    const nivelCaiu = nivelAtual !== null && nivelAtual <= c.nivelAntes - v.deltaNivelPct;

    if (umidSubiu && nivelCaiu) {
      this.emCurso = null;
      return { resultado: 'CONFIRMADO', commandId: c.commandId };
    }
    if (agora - c.inicio >= v.janelaMs) {
      const diagnostico = !umidSubiu && !nivelCaiu ? 'bomba_sem_fluxo'
        : !umidSubiu ? 'agua_nao_chegou_ao_vaso'
        : 'sensor_nivel_suspeito';
      this.emCurso = null;
      this.bloqueadaDesde = agora;
      this.diagnostico = diagnostico;
      return { resultado: 'FALHOU', commandId: c.commandId, diagnostico };
    }
    return null;
  }

  bloqueada(agora) {
    if (this.bloqueadaDesde === null) return false;
    if (agora - this.bloqueadaDesde >= (this.cfg.verificacao.bloqueioMs || 120000)) {
      this.liberar();
      return false;
    }
    return true;
  }

  liberar() {
    this.bloqueadaDesde = null;
    this.diagnostico = null;
  }

  /*
   * Marco 4 -- persistencia. O BLOQUEIO sobrevive ao reinicio (relogio de
   * parede): reiniciar o servico nao pode ser um jeito de religar uma bomba
   * que nao bombeia. Uma verificacao EM CURSO nao: as leituras do intervalo
   * em que o servico esteve fora se perderam, e julgar o efeito sem elas daria
   * um diagnostico falso.
   */
  exportar() {
    return { bloqueadaDesde: this.bloqueadaDesde, diagnostico: this.diagnostico, emCurso: this.emCurso };
  }

  restaurar(s) {
    if (!s) return [];
    const notas = [];
    this.bloqueadaDesde = s.bloqueadaDesde ?? null;
    this.diagnostico = s.diagnostico ?? null;
    this.emCurso = null;
    if (this.bloqueadaDesde !== null) notas.push(`irrigacao continua bloqueada (${this.diagnostico})`);
    if (s.emCurso) notas.push(`verificacao de ${s.emCurso.commandId} descartada (interrompida pelo reinicio)`);
    return notas;
  }

  resumo() {
    return { emCurso: this.emCurso, bloqueada: this.bloqueadaDesde !== null, diagnostico: this.diagnostico };
  }
}

module.exports = { VerificacaoIrrigacao };

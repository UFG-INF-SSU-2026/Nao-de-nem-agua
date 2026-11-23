'use strict';
/*
 * Marco 4 -- R3: nutrientes (EC) -> bomba de fertilizante.
 *
 * Maquina de estados no servico. O dispositivo so mede (EC compensada e
 * normalizada, com validade propria) e executa a dose -- recusando-a com
 * REJEITADO_SEGURANCA se o solo estiver seco, a outra bomba ligada ou o
 * reservatorio de adubo critico.
 *
 *  OCIOSO ──(gatilho; doses na janela ok; cooldown de tentativa ok)──►
 *     gatilho A: media da EC25 valida < ec25Min
 *     gatilho B ("suspeita"): EC invalida porque o solo esta seco E a EC
 *               aparente < ec25Min -- pode ser so falta de agua
 *  ├─ solo < umidadeMin ──► AGUARDANDO_IRRIGACAO (pede pulso a R2)
 *  │                         ──(solo >= umidadeMin)──► AGUARDANDO_ABSORCAO ──(absorcaoMs)──► MEDINDO
 *  └─ solo na faixa ──────────────────────────────────────────────────────────────────────► MEDINDO
 *  MEDINDO (media de N leituras de EC validas, coletadas AGORA)
 *     ├─ ainda < ec25Min ──► DOSANDO
 *     └─ >= ec25Min ───────► OCIOSO  (falso_positivo_evitado: era so solo seco)
 *  DOSANDO ──(ack EXECUTADO)──► VERIFICANDO ──(EC subiu E nivel do adubo caiu)──► OCIOSO
 *          ──(ack REJEITADO_*)──► OCIOSO (alerta ATUACAO_RECUSADA)
 *  VERIFICANDO ──(prazo)──► BLOQUEADA (alerta FALHA_ADUBACAO) ──(reconhecer ou bloqueioMs)──► OCIOSO
 *
 * EC acima de ec25Max gera EXCESSO_NUTRIENTES. O sistema NAO atua nesse caso:
 * a correcao (lavar o substrato) e do usuario.
 */

const ESTADOS_ADUBO = {
  OCIOSO: 'OCIOSO',
  AGUARDANDO_IRRIGACAO: 'AGUARDANDO_IRRIGACAO',
  AGUARDANDO_ABSORCAO: 'AGUARDANDO_ABSORCAO',
  MEDINDO: 'MEDINDO',
  DOSANDO: 'DOSANDO',
  VERIFICANDO: 'VERIFICANDO',
  BLOQUEADA: 'BLOQUEADA'
};

class RegraAdubacao {
  /*
   * deps: { estadoVaso, reservatorios, atuadores, alertas, log, irrigacaoBloqueada() }
   */
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.d = deps;
    this.estado = ESTADOS_ADUBO.OCIOSO;
    this.desde = Date.now();
    this.ultimaLeitura = null;
    this.ecJanela = [];
    this.medicao = [];
    this.ecMedida = null;
    this.nivelAntes = null;
    this.comando = null;
    this.enviadoEm = null;
    this.bombaAteMs = 0;
    this.ultimaTentativaEm = null;
    this.doses = [];
    this.excessoAtivo = false;
    this.avisos = new Set(); // motivos de espera ja registrados neste estado
  }

  get a() {
    return this.cfg.adubacao;
  }

  // -------------------------------------------------------------------------
  // Entradas
  // -------------------------------------------------------------------------

  /* Leitura de solo corrente (valida, nao replayed), ja aplicada no estadoVaso. */
  registrarLeitura(payload, agora) {
    this.ultimaLeitura = payload;
    if (payload.ecValid !== true || typeof payload.ec25UsCm !== 'number') return;

    this.ecJanela.push(payload.ec25UsCm);
    while (this.ecJanela.length > this.a.amostrasMedia) this.ecJanela.shift();
    if (this.estado === ESTADOS_ADUBO.MEDINDO) this.medicao.push(payload.ec25UsCm);
    this.verificarExcesso(payload);
    this.avaliar(agora);
  }

  /* Leitura invalida ou falha do solo: a media antiga deixa de valer. */
  descartarMedia() {
    this.ecJanela = [];
    this.medicao = [];
  }

  /* Ack legitimo de um comando BOMBA_ADUBO emitido por esta regra. */
  aoConfirmar(comando, ack, agora) {
    if (!this.comando || comando.commandId !== this.comando.commandId) return;
    if (this.estado !== ESTADOS_ADUBO.DOSANDO) return;
    if (ack.result === 'EXECUTADO') {
      this.registrarDose(agora);
      this.bombaAteMs = agora + this.a.pulsoMs;
      this.mudar(ESTADOS_ADUBO.VERIFICANDO, 'dose_executada', agora);
    } else {
      this.d.alertas.emitir('ATUACAO_RECUSADA', 'ATENCAO',
        `Dose de fertilizante recusada pelo dispositivo: ${ack.result}${ack.detail ? ` (${ack.detail})` : ''}.`,
        comando.commandId);
      this.cancelar(`dose_recusada_${ack.result.toLowerCase()}`, agora);
    }
  }

  reconhecer(agora) {
    if (this.estado !== ESTADOS_ADUBO.BLOQUEADA) return false;
    this.cancelar('falha_reconhecida', agora);
    return true;
  }

  // -------------------------------------------------------------------------
  // Saidas para a R2
  // -------------------------------------------------------------------------

  /* Pedido de irrigacao para preparar o solo antes da dose. */
  pedidoIrrigacao() {
    return this.estado === ESTADOS_ADUBO.AGUARDANDO_IRRIGACAO ? 'preparar_adubacao' : null;
  }

  /* Intertravamento: enquanto a dose pode estar correndo, a R2 nao pede agua. */
  bloqueioIrrigacao(agora) {
    if (this.estado === ESTADOS_ADUBO.DOSANDO && this.comando) return 'intertravamento_bomba_adubo';
    if (agora < this.bombaAteMs) return 'intertravamento_bomba_adubo';
    return null;
  }

  // -------------------------------------------------------------------------
  // Maquina de estados
  // -------------------------------------------------------------------------

  avaliar(agora) {
    const ev = this.d.estadoVaso;
    switch (this.estado) {
      case ESTADOS_ADUBO.OCIOSO:
        return this.avaliarOcioso(agora);

      case ESTADOS_ADUBO.AGUARDANDO_IRRIGACAO:
        if (this.d.irrigacaoBloqueada(agora)) return this.cancelar('irrigacao_bloqueada', agora);
        if (!ev.emFalha() && ev.ultimoValor !== null && ev.ultimoValor >= this.a.umidadeMinPct) {
          return this.mudar(ESTADOS_ADUBO.AGUARDANDO_ABSORCAO, 'solo_umedecido', agora);
        }
        if (agora - this.desde >= this.a.timeoutIrrigacaoMs) return this.cancelar('timeout_irrigacao', agora);
        return;

      case ESTADOS_ADUBO.AGUARDANDO_ABSORCAO:
        if (agora - this.desde >= this.a.absorcaoMs) this.iniciarMedicao('absorcao_concluida', agora);
        return;

      case ESTADOS_ADUBO.MEDINDO:
        return this.avaliarMedindo(agora);

      case ESTADOS_ADUBO.DOSANDO:
        return this.avaliarDosando(agora);

      case ESTADOS_ADUBO.VERIFICANDO:
        return this.avaliarVerificando(agora);

      case ESTADOS_ADUBO.BLOQUEADA:
        if (agora - this.desde >= (this.cfg.verificacao.bloqueioMs || 120000)) {
          this.cancelar('bloqueio_expirado', agora);
        }
        return;

      default:
    }
  }

  avaliarOcioso(agora) {
    const ev = this.d.estadoVaso;
    const l = this.ultimaLeitura;
    if (!l || ev.emFalha()) return;
    if (this.ultimaTentativaEm !== null && agora - this.ultimaTentativaEm < this.a.cooldownTentativaMs) return;

    let gatilho = null;
    if (l.ecValid === true && this.ecJanela.length >= this.a.amostrasMedia && this.mediaEc() < this.a.ec25MinUsCm) {
      gatilho = 'ec_abaixo_minimo';
    } else if (l.ecValid === false && typeof l.ecApparentUsCm === 'number' &&
               l.value < this.a.umidadeMinPct && l.ecApparentUsCm < this.a.ec25MinUsCm) {
      gatilho = 'suspeita_ec_baixa_solo_seco';
    }
    if (!gatilho) return;

    if (this.dosesNaJanela(agora) >= this.a.maxDoses) {
      this.avisar('limite_de_doses_na_janela');
      return;
    }
    this.ultimaTentativaEm = agora;
    this.d.log.registrar('ADUBACAO', `gatilho ${gatilho} (EC media ${this.fmt(this.mediaEc())} uS/cm, solo ${ev.ultimoValor}%)`);
    if (ev.ultimoValor < this.a.umidadeMinPct) {
      this.mudar(ESTADOS_ADUBO.AGUARDANDO_IRRIGACAO, `${gatilho}_solo_seco_irrigar_antes`, agora);
    } else {
      this.iniciarMedicao(gatilho, agora);
    }
  }

  avaliarMedindo(agora) {
    if (this.d.estadoVaso.emFalha()) return this.cancelar('sonda_em_falha', agora);
    if (this.medicao.length >= this.a.amostrasMedia) {
      this.ecMedida = this.medicao.reduce((s, v) => s + v, 0) / this.medicao.length;
      if (this.ecMedida < this.a.ec25MinUsCm) {
        this.comando = null;
        return this.mudar(ESTADOS_ADUBO.DOSANDO, `ec_baixa_confirmada_${Math.round(this.ecMedida)}`, agora);
      }
      return this.cancelar(`falso_positivo_evitado_ec_${Math.round(this.ecMedida)}`, agora);
    }
    if (agora - this.desde >= this.a.timeoutMedicaoMs) this.cancelar('ec_sem_leitura_valida', agora);
  }

  avaliarDosando(agora) {
    const ev = this.d.estadoVaso;
    if (!this.comando) {
      const bloqueio =
        ev.emFalha() ? 'sonda_em_falha'
        : this.d.reservatorios.critico('ADUBO') ? 'reservatorio_adubo_critico'
        // pulsoAteMs: fim estimado do ultimo pulso de agua. bombaLigada nao
        // serve aqui -- no Marco 3 ela significa "irrigacao em curso" e fica
        // verdadeira em toda a faixa da histerese, muito depois do pulso.
        : agora < (ev.pulsoAteMs || 0) ? 'intertravamento_bomba_agua'
        : ev.ultimoValor < this.a.umidadeMinPct ? 'solo_seco_nao_adubar'
        : null;
      if (bloqueio) {
        this.avisar(bloqueio);
        if (agora - this.desde >= this.a.timeoutMedicaoMs) this.cancelar(bloqueio, agora);
        return;
      }
      // O prazo do comando e ancorado no ultimo evento de solo (relogio do
      // dispositivo). Com o evento velho, o comando ja nasceria vencido:
      // espera a proxima leitura.
      if (agora - ev.recebidoEm > this.cfg.regra.comandoTtlMs / 2) return;
      this.nivelAntes = this.d.reservatorios.nivelConfiavel('ADUBO');
      this.comando = this.d.atuadores.publicar('BOMBA_ADUBO', 'PULSO', 'ec_abaixo_minimo', {
        eventId: ev.ultimoEventId, eventTimeMs: ev.ultimoEventTimeMs, deviceId: ev.deviceId
      }, this.a.pulsoMs);
      if (!this.comando) return this.cancelar('comando_nao_publicado', agora);
      this.enviadoEm = agora;
      return;
    }
    // Sem ack no prazo: a suposicao segura sobre um efeito fisico e a de que
    // ele ocorreu (mesma politica do Marco 3) -- conta a dose e verifica.
    if (agora - this.enviadoEm >= this.cfg.regra.comandoTtlMs + this.a.pulsoMs + 2000) {
      this.d.log.registrar('ADUBACAO', `sem ack de ${this.comando.commandId}: dose assumida como aplicada`);
      this.registrarDose(agora);
      this.mudar(ESTADOS_ADUBO.VERIFICANDO, 'dose_assumida_sem_ack', agora);
    }
  }

  avaliarVerificando(agora) {
    const media = this.mediaEc();
    const ecSubiu = media !== null && media >= this.ecMedida + this.a.deltaEcUsCm;
    const nivel = this.d.reservatorios.nivelConfiavel('ADUBO');
    const nivelCaiu = this.nivelAntes === null || (nivel !== null && nivel <= this.nivelAntes - this.a.deltaNivelPct);

    if (ecSubiu && nivelCaiu) {
      this.d.alertas.emitir('ADUBACAO_EXECUTADA', 'INFO',
        `Fertilizante aplicado: EC ${Math.round(this.ecMedida)} -> ${Math.round(media)} uS/cm.`, this.comando.commandId);
      return this.cancelar('efeito_confirmado', agora);
    }
    if (agora - this.desde >= this.a.janelaVerificacaoMs) {
      const diag = !ecSubiu && !nivelCaiu ? 'bomba_adubo_sem_fluxo'
        : !ecSubiu ? 'adubo_nao_chegou_ao_vaso'
        : 'sensor_nivel_adubo_suspeito';
      this.d.alertas.emitir('FALHA_ADUBACAO', 'CRITICO',
        `Dose sem efeito confirmado (${diag}). Adubacao automatica bloqueada.`, this.comando.commandId);
      this.mudar(ESTADOS_ADUBO.BLOQUEADA, diag, agora);
    }
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  verificarExcesso(payload) {
    if (this.ecJanela.length < this.a.amostrasMedia) return;
    const m = this.mediaEc();
    if (!this.excessoAtivo && m > this.a.ec25MaxUsCm) {
      this.excessoAtivo = true;
      this.d.alertas.emitir('EXCESSO_NUTRIENTES', 'ATENCAO',
        `EC ${Math.round(m)} uS/cm acima do maximo da especie. Recomenda-se lavar o substrato; nenhuma atuacao automatica.`,
        payload.eventId);
    } else if (this.excessoAtivo && m < this.a.ec25MaxUsCm - this.a.histereseExcessoUsCm) {
      this.excessoAtivo = false;
      this.d.log.registrar('ADUBACAO', `EC normalizada (${Math.round(m)} uS/cm)`);
    }
  }

  iniciarMedicao(motivo, agora) {
    this.medicao = [];
    this.mudar(ESTADOS_ADUBO.MEDINDO, motivo, agora);
  }

  /* Volta a OCIOSO (por sucesso ou cancelamento) e reinicia o cooldown de tentativa. */
  cancelar(motivo, agora) {
    this.mudar(ESTADOS_ADUBO.OCIOSO, motivo, agora);
    this.comando = null;
    this.ultimaTentativaEm = agora;
  }

  mudar(novo, motivo, agora) {
    const anterior = this.estado;
    this.estado = novo;
    this.desde = agora;
    this.avisos.clear();
    this.d.log.registrar('ADUBACAO', `${anterior} -> ${novo} (${motivo})`, { anterior, atual: novo, motivo });
  }

  avisar(motivo) {
    if (this.avisos.has(motivo)) return;
    this.avisos.add(motivo);
    this.d.log.registrar('ADUBACAO', `${this.estado}: aguardando (${motivo})`, { motivo });
  }

  mediaEc() {
    if (this.ecJanela.length === 0) return null;
    return this.ecJanela.reduce((s, v) => s + v, 0) / this.ecJanela.length;
  }

  dosesNaJanela(agora) {
    this.doses = this.doses.filter((t) => agora - t < this.a.janelaDosesMs);
    return this.doses.length;
  }

  registrarDose(agora) {
    this.doses.push(agora);
  }

  fmt(v) {
    return v === null ? '-' : Math.round(v);
  }

  resumo(agora) {
    return {
      estado: this.estado,
      ecMedia: this.mediaEc() === null ? null : Math.round(this.mediaEc()),
      dosesNaJanela: this.dosesNaJanela(agora),
      excesso: this.excessoAtivo
    };
  }
}

module.exports = { RegraAdubacao, ESTADOS_ADUBO };

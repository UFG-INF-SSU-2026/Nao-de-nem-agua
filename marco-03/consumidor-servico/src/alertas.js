'use strict';

const { randomUUID } = require('crypto');
const contrato = require('../../contrato');
const { ESTADOS_DE_FALHA } = require('./estado');
const LIMITE = 500;

// A confirmação fica junto do comando: retries não repetem efeitos e a ordem
// de chegada dos acks não determina a ação original.
class AlertasCuidado {
  constructor(cliente, cfg, log) {
    this.cliente = cliente;
    this.cfg = cfg;
    this.log = log;
    this.executionId = randomUUID();
    this.sequencia = 0;
    this.comandos = new Map();
  }

  registrarComando(comando) {
    this.comandos.set(comando.commandId, { comando, confirmado: false });
    if (this.comandos.size > LIMITE) this.comandos.delete(this.comandos.keys().next().value);
  }

  emitir(alertType, severity, message, correlationId) {
    const alerta = {
      schemaVersion: 1,
      eventId: `servico-irrigacao:${this.executionId}:${String(++this.sequencia).padStart(6, '0')}`,
      eventType: 'AlertaCuidado', producerId: 'servico-irrigacao',
      entityId: this.cfg.identidade.vasoId, alertType, severity, message,
      correlationId, issuedAt: new Date().toISOString(), ttlMs: this.cfg.alertas.ttlMs
    };
    const resultado = contrato.validar('AlertaCuidado', alerta);
    if (!resultado.ok) {
      this.log.registrar('REJEITADO', 'alerta gerado viola contrato', { ...resultado, alerta });
      return;
    }
    this.log.registrar('ALERTA', `${alerta.eventId} ${alertType} ${severity} origem=${correlationId}`, alerta);
    this.cliente.publish(contrato.topicos(this.cfg).alertaCuidado, JSON.stringify(alerta),
      { qos: 1, retain: false }, erro => {
        if (erro) this.log.registrar('REJEITADO', `falha de transporte do alerta: ${erro.message}`, alerta);
        else this.log.registrar('TRANSPORTE', `PUBACK do alerta ${alerta.eventId}`, { eventId: alerta.eventId });
      });
  }

  transicao(t, estado, origem) {
    if (!t || t.anterior === t.atual) return;
    if (t.atual === 'AUTORIZADO') {
      this.emitir('SOLO_SECO', 'ATENCAO', `O ${estado.vasoId} está com o solo seco há ${estado.consecutivasSecas} leituras. Irrigação autorizada.`, origem.eventId);
    } else if (t.atual === 'DADO_OBSOLETO' && t.motivo === 'validade_expirada') {
      this.emitir('DADO_OBSOLETO', 'ATENCAO', 'Validade da última leitura expirada.', estado.ultimoEventId);
    } else if (t.atual === 'DISPOSITIVO_OFFLINE') {
      // LWT v1 pode não ter eventId. deviceId é a referência real disponível;
      // bootId e tópico ficam no log para explicitar a relação sem inventar IDs.
      const correlationId = origem.eventId || origem.deviceId;
      this.log.registrar('ORIGEM_LWT', 'origem do alerta offline', { correlationId, origem, topico: contrato.topicos(this.cfg).heartbeat });
      this.emitir('DISPOSITIVO_OFFLINE', 'CRITICO', 'Dispositivo offline (LWT).', correlationId);
    } else if (t.atual === 'NORMAL' && ESTADOS_DE_FALHA.has(t.anterior) && t.anterior !== 'DESCONHECIDO') {
      this.emitir('DISPOSITIVO_RECUPERADO', 'INFO', 'Dispositivo recuperado; leitura normal recebida.', origem.eventId);
    }
  }

  confirmar(ack) {
    const registro = this.comandos.get(ack.commandId);
    if (!registro || registro.confirmado) return null;
    const cmd = registro.comando;
    if (ack.correlationId !== cmd.correlationId || (ack.bootId && ack.bootId !== cmd.bootIdOrigem)) return null;
    if (ack.deviceId !== cmd.deviceIdOrigem) return null;
    // O ack de um retry pode ultrapassar o resultado original na rede. Ele não
    // informa uma nova execução nem encerra a espera pelo EXECUTADO original.
    if (ack.result === 'IGNORADO_DUPLICADO') return null;
    registro.confirmado = true;
    if (cmd.action === 'PULSO_IRRIGACAO') {
      if (ack.result === 'EXECUTADO') this.emitir('IRRIGACAO_EXECUTADA', 'INFO', 'Pulso de irrigação executado pelo dispositivo.', ack.commandId);
      else if (ack.result.startsWith('REJEITADO_')) this.emitir('IRRIGACAO_RECUSADA', 'ATENCAO', `Irrigação recusada: ${ack.result}.`, ack.commandId);
    }
    return cmd;
  }
}

module.exports = { AlertasCuidado };

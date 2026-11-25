'use strict';
/*
 * Marco 4 -- emissao e confirmacao de ComandoAtuador (umidificador e bomba de
 * fertilizante).
 *
 * Mesmos compromissos do ComandoIrrigacao do Marco 3: identidade, chave
 * idempotente, prazo no relogio do dispositivo (ancorado no evento que originou
 * a decisao), correlacao, validacao do proprio comando antes de publicar e
 * assinatura com a chave do dispositivo de destino. O ack so corrige o estado
 * se vier do dispositivo que recebeu o comando e para um comando que ESTE
 * servico emitiu.
 */

const contrato = require('../../contrato');
const seguranca = require('../../seguranca');

const LIMITE = 500;

class Atuadores {
  constructor(cliente, cfg, log, topicos, persistencia) {
    this.cliente = cliente;
    this.persistencia = persistencia || null; // Marco 4: historico de comandos
    this.cfg = cfg;
    this.log = log;
    this.topicos = topicos;
    this.contador = 0;
    this.pendentes = new Map(); // commandId -> { comando, deviceId, confirmado }
  }

  /*
   * Monta, valida, assina e publica. `origem` = { eventId, eventTimeMs, deviceId }
   * do evento que motivou a decisao. Devolve o comando ou null.
   */
  publicar(actuator, action, reason, origem, durationMs) {
    if (!origem || !origem.eventId || origem.eventTimeMs === null || origem.eventTimeMs === undefined) {
      this.log.registrar('SEM_ACAO', `${actuator} ${action} sem evento de origem para ancorar o prazo`);
      return null;
    }
    this.contador += 1;
    const commandId = `atu-${String(this.contador).padStart(6, '0')}`;
    const ttlMs = this.cfg.regra.comandoTtlMs;
    const comando = {
      schemaVersion: 1,
      commandId,
      idempotencyKey: commandId,
      commandType: 'ComandoAtuador',
      targetId: this.cfg.identidade.vasoId,
      actuator,
      action,
      correlationId: origem.eventId,
      correlationEventTimeMs: origem.eventTimeMs,
      ttlMs,
      expiresAtDeviceMs: origem.eventTimeMs + ttlMs,
      issuedAt: new Date().toISOString(),
      reason
    };
    if (durationMs !== undefined) comando.durationMs = durationMs;

    const valido = contrato.validar('ComandoAtuador', comando);
    if (!valido.ok) {
      this.log.registrar('REJEITADO', `comando de atuador viola o contrato: ${valido.detalhe}`, { comando });
      return null;
    }
    const disp = seguranca.dispositivo(origem.deviceId);
    if (!disp) {
      this.log.registrar('REJEITADO', `sem chave para assinar o comando (deviceId=${origem.deviceId})`, { comando });
      return null;
    }
    const texto = seguranca.assinar(disp.chave, this.topicos.comandoAtuador, comando);
    this.pendentes.set(commandId, { comando, deviceId: origem.deviceId, confirmado: false });
    if (this.pendentes.size > LIMITE) this.pendentes.delete(this.pendentes.keys().next().value);

    this.log.registrar('DECISAO', `${actuator} ${action} porque ${reason}`, { comando });
    if (this.persistencia) {
      this.persistencia.gravar('comandos', {
        command_id: commandId, tipo: 'ComandoAtuador', atuador: actuator, acao: action, motivo: reason,
        correlation_id: origem.eventId, duracao_ms: durationMs ?? null, device_id: origem.deviceId, payload: comando
      });
    }
    this.cliente.publish(this.topicos.comandoAtuador, texto, { qos: this.cfg.mqtt.qos }, (erro) => {
      if (erro) this.log.registrar('REJEITADO', `falha ao publicar ${commandId}: ${erro.message}`);
      else this.log.registrar('COMANDO', `${commandId} publicado -> ${actuator} ${action}` +
        (durationMs ? ` (${durationMs}ms)` : ''), { comando });
    });
    return comando;
  }

  /*
   * Devolve o comando original se o ack for legitimo e terminal; null caso
   * contrario (desconhecido, de outro dispositivo, correlacao errada, ja
   * confirmado, ou IGNORADO_DUPLICADO -- que nao informa execucao nova).
   */
  confirmar(ack) {
    const reg = this.pendentes.get(ack.commandId);
    if (!reg || reg.confirmado) return null;
    if (ack.deviceId !== reg.deviceId || ack.correlationId !== reg.comando.correlationId) return null;
    if (ack.result === 'IGNORADO_DUPLICADO') return null;
    reg.confirmado = true;
    return reg.comando;
  }
}

module.exports = { Atuadores };

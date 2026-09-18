'use strict';
/*
 * Regra de decisao e emissao de comando.
 *
 * Origem: recorte "decisao e atuacao" do Marco 1 (histerese de dois limiares +
 * debounce + cooldown). O mecanismo e o mesmo; o que a fronteira de comunicacao
 * acrescenta e que a decisao agora vira um COMANDO que atravessa a rede -- e
 * comando tem compromissos que uma escrita em digitalWrite() nao tem:
 *
 *   - precisa de identidade (commandId) para poder ser reconhecido;
 *   - precisa de chave idempotente, porque um retry nao pode irrigar duas vezes;
 *   - precisa de prazo de validade, porque agua aplicada tarde ja nao responde
 *     a pergunta que originou a decisao;
 *   - precisa de correlacao com o evento que o causou, para ser auditavel.
 *
 * A histerese aqui governa a AUTORIZACAO; o cooldown governa a frequencia dos
 * pulsos. Sao mecanismos distintos de proposito: o primeiro impede que ruido
 * proximo ao limiar vire decisao, o segundo impede que decisoes legitimas mas
 * frequentes virem excesso de agua.
 */

const { ESTADOS } = require('./estado');

let contadorComandos = 0;

function proximoCommandId() {
  contadorComandos += 1;
  return `cmd-${String(contadorComandos).padStart(6, '0')}`;
}

/*
 * Decide o que fazer diante do estado corrente.
 * Devolve { comando, motivoNaoAtuou } -- nunca atua diretamente: quem publica
 * e o main.js. Manter a regra pura torna possivel testa-la sem broker.
 */
function decidir(estadoVaso, cfg, agora) {
  const regra = cfg.regra;

  // Comportamento seguro: em qualquer estado de falha (dado obsoleto, leitura
  // invalida, dispositivo offline, estado desconhecido) NAO se comanda nada.
  // Se a bomba estava ligada, manda parar -- deixar a bomba ligada sem dado
  // confiavel e a pior das opcoes.
  if (estadoVaso.emFalha()) {
    if (estadoVaso.bombaLigada) {
      return {
        comando: montarComando(estadoVaso, cfg, 'PARAR_IRRIGACAO', `estado_${estadoVaso.estado.toLowerCase()}`),
        motivoNaoAtuou: null
      };
    }
    return { comando: null, motivoNaoAtuou: `estado_${estadoVaso.estado.toLowerCase()}` };
  }

  // Histerese, ramo superior: so desliga ao cruzar o limiar de cima.
  // Enquanto o valor oscilar entre os dois limiares, a bomba nao muda de
  // estado -- e isso que evita o liga/desliga repetido.
  if (estadoVaso.bombaLigada) {
    if (estadoVaso.ultimoValor > regra.limiarDesliga) {
      return {
        comando: montarComando(estadoVaso, cfg, 'PARAR_IRRIGACAO', 'umidade_acima_do_limiar_desliga'),
        motivoNaoAtuou: null
      };
    }
    // Ainda na faixa de histerese: renova o pulso, mas so respeitando o cooldown.
    if (estadoVaso.estado === ESTADOS.AUTORIZADO && cooldownVencido(estadoVaso, regra, agora)) {
      return {
        comando: montarComando(estadoVaso, cfg, 'PULSO_IRRIGACAO', 'renovacao_pulso_autorizado'),
        motivoNaoAtuou: null
      };
    }
    return { comando: null, motivoNaoAtuou: 'dentro_da_histerese' };
  }

  // Histerese, ramo inferior: liga apenas quando o estado ja confirmou as
  // amostras secas consecutivas (debounce, feito em estado.js) E o cooldown
  // venceu.
  if (estadoVaso.estado !== ESTADOS.AUTORIZADO) {
    return { comando: null, motivoNaoAtuou: `estado_${estadoVaso.estado.toLowerCase()}` };
  }

  if (!cooldownVencido(estadoVaso, regra, agora)) {
    return { comando: null, motivoNaoAtuou: 'cooldown_ativo' };
  }

  return {
    comando: montarComando(estadoVaso, cfg, 'PULSO_IRRIGACAO', 'umidade_abaixo_do_limiar_liga'),
    motivoNaoAtuou: null
  };
}

function cooldownVencido(estadoVaso, regra, agora) {
  if (estadoVaso.ultimoComandoEm === null) return true;
  return agora - estadoVaso.ultimoComandoEm >= regra.cooldownMs;
}

function montarComando(estadoVaso, cfg, acao, motivo) {
  const commandId = proximoCommandId();

  /*
   * A expiracao e expressa no RELOGIO DO DISPOSITIVO.
   *
   * Nao ha NTP neste recorte, logo o dispositivo nao pode comparar um instante
   * gerado pelo relogio do servico com o proprio millis(). A saida e ancorar o
   * prazo no tempo do evento que originou a decisao -- esse sim esta no
   * dominio do dispositivo -- e somar o TTL. O dispositivo compara
   * millis() >= expiresAtDeviceMs usando apenas o seu proprio relogio.
   */
  const expiresAtDeviceMs = estadoVaso.ultimoEventTimeMs + cfg.regra.comandoTtlMs;

  const comando = {
    schemaVersion: 1,
    commandId,
    idempotencyKey: commandId,
    commandType: 'ComandoIrrigacao',
    targetId: estadoVaso.vasoId,
    action: acao,
    correlationId: estadoVaso.ultimoEventId,
    correlationEventTimeMs: estadoVaso.ultimoEventTimeMs,
    ttlMs: cfg.regra.comandoTtlMs,
    expiresAtDeviceMs,
    issuedAt: new Date().toISOString(),
    reason: motivo
  };

  if (acao === 'PULSO_IRRIGACAO') {
    comando.durationMs = cfg.regra.duracaoPulsoMs;
  }

  return comando;
}

module.exports = { decidir };

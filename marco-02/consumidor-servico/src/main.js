'use strict';
/*
 * servico-irrigacao -- COMPONENTE CONSUMIDOR do Marco 2.
 *
 * Assina a telemetria e o heartbeat do gateway, valida o contrato, deduplica,
 * aplica a validade temporal, decide pela regra de histerese e publica um
 * comando idempotente de volta. Consome tambem as confirmacoes de negocio.
 *
 * Fronteira: dispositivo <-> nuvem (Atividade 02, itens 10 e 11). Este processo
 * ocupa o lado "nuvem": e dele o estado da janela, os limiares e a decisao. O
 * dispositivo conserva apenas leitura, validacao local e atuacao.
 *
 * Pipeline, na ordem:
 *   1. desserializacao tolerante   (JSON quebrado nao derruba o servico)
 *   2. versao + schema             (contrato/v1, via ajv)
 *   3. deduplicacao por eventId    (retry nao reprocessa)
 *   4. eventos historicos          (replayed: registra, mas nao renova validade)
 *   5. validade / expiracao        (dado velho nao autoriza atuacao)
 *   6. decisao                     (histerese + debounce + cooldown)
 *   7. comando idempotente         (com correlacao e prazo de validade)
 */

const mqtt = require('mqtt');
const path = require('path');
const contrato = require('../../contrato');
const { EstadoVaso } = require('./estado');
const { decidir } = require('./decisao');
const { Log, CORES } = require('./log');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);
const RAIZ = path.resolve(__dirname, '../..');

const log = new Log(path.join(RAIZ, cfg.log.arquivoJsonl));
const estado = new EstadoVaso(cfg.identidade.vasoId, cfg);

let ultimaAcaoEnviada = null;
let ultimoComandoEmitido = null;

console.log('');
console.log(`${CORES.negrito}servico-irrigacao${CORES.reset} -- consumidor do Marco 2`);
console.log(`  broker      ${cfg.mqtt.url}`);
console.log(`  assina      ${topicos.telemetriaSolo}`);
console.log(`              ${topicos.heartbeat}`);
console.log(`              ${topicos.ackIrrigacao}`);
console.log(`  publica     ${topicos.comandoIrrigacao}`);
console.log(
  `  regra       liga<${cfg.regra.limiarLiga}% desliga>${cfg.regra.limiarDesliga}% ` +
    `debounce=${cfg.regra.amostrasDebounce} cooldown=${cfg.regra.cooldownMs}ms ` +
    `validade=${cfg.regra.validadeMs}ms ttl=${cfg.regra.comandoTtlMs}ms`
);
console.log('');

// ---------------------------------------------------------------------------
// Conexao
// ---------------------------------------------------------------------------

const cliente = mqtt.connect(cfg.mqtt.url, {
  clientId: `servico-irrigacao-${Math.random().toString(16).slice(2, 8)}`,
  clean: true,
  reconnectPeriod: 2000,
  connectTimeout: 8000
});

cliente.on('connect', () => {
  log.registrar('CONEXAO', `conectado a ${cfg.mqtt.url}`);
  cliente.subscribe(
    [topicos.telemetriaSolo, topicos.heartbeat, topicos.ackIrrigacao],
    { qos: cfg.mqtt.qos },
    (erro) => {
      if (erro) log.registrar('REJEITADO', `falha ao assinar: ${erro.message}`);
      else log.registrar('CONEXAO', `assinaturas ativas (QoS ${cfg.mqtt.qos})`);
    }
  );
});

/*
 * O servico nao morre quando o broker cai: reconecta com intervalo fixo. Mas
 * tambem nao finge que o mundo parou -- ao perder o broker, deixa de ter
 * informacao sobre o dispositivo, e o tick de validade vai expirar o dado
 * sozinho. Silencio nao e sinal de normalidade.
 */
cliente.on('reconnect', () => log.registrar('CONEXAO', 'tentando reconectar ao broker'));
cliente.on('close', () => log.registrar('CONEXAO', 'conexao com o broker encerrada'));
cliente.on('error', (e) => log.registrar('REJEITADO', `erro de conexao: ${e.message}`));

// ---------------------------------------------------------------------------
// Recepcao
// ---------------------------------------------------------------------------

cliente.on('message', (topico, buffer) => {
  const agora = Date.now();

  // Etapa 1 -- desserializacao tolerante.
  const bruto = contrato.desserializar(buffer);
  if (!bruto.ok) {
    log.registrar('REJEITADO', `${bruto.motivo} em ${topico}: ${bruto.detalhe}`, {
      topico,
      motivo: bruto.motivo
    });
    return;
  }

  if (topico === topicos.telemetriaSolo) return tratarTelemetria(bruto.payload, agora);
  if (topico === topicos.heartbeat) return tratarHeartbeat(bruto.payload, agora);
  if (topico === topicos.ackIrrigacao) return tratarAck(bruto.payload);

  log.registrar('REJEITADO', `topico inesperado: ${topico}`, { topico });
});

function tratarTelemetria(payload, agora) {
  // Etapa 2 -- versao e schema.
  const valido = contrato.validar('LeituraUmidadeSolo', payload);
  if (!valido.ok) {
    log.registrar('REJEITADO', `${valido.motivo}: ${valido.detalhe || ''}`, {
      motivo: valido.motivo,
      detalhe: valido.detalhe,
      payload
    });
    return;
  }

  log.registrar(
    'RECEBIDO',
    `${payload.eventId} valor=${payload.value}% seq=${payload.sequence}` +
      (payload.replayed ? ' (replayed)' : ''),
    { eventId: payload.eventId, value: payload.value, sequence: payload.sequence }
  );

  // Etapa 3 -- deduplicacao. O mesmo eventId nunca e processado duas vezes.
  if (estado.jaVisto(payload.eventId)) {
    log.registrar(
      'DUPLICADO',
      `${payload.eventId} ja processado -- descartado sem reprocessar estado`,
      { eventId: payload.eventId }
    );
    return;
  }
  estado.registrarEventId(payload.eventId);

  // Etapa 3b -- a validacao local do dispositivo veio negativa.
  if (payload.valid === false) {
    const t = estado.marcarLeituraInvalida(payload.invalidReason || 'leitura_invalida');
    log.registrar('ESTADO', `${t.anterior} -> ${t.atual} (${t.motivo})`, { transicao: t });
    avaliarEAtuar(agora);
    return;
  }

  /*
   * Etapa 4 -- evento historico.
   *
   * Um evento com replayed:true vem do buffer offline do dispositivo: foi
   * medido durante a queda e so chegou depois. Ele e registrado e deduplicado,
   * mas NAO renova a validade do dado corrente nem realimenta a decisao --
   * caso contrario, uma rajada de leituras antigas chegando de uma vez faria o
   * servico decidir sobre um passado que ja nao descreve o presente. E a
   * politica de eventos atrasados da Atividade 02, item 8.
   */
  if (payload.replayed === true) {
    log.registrar('HISTORICO', `${payload.eventId} arquivado (nao renova validade nem decide)`, {
      eventId: payload.eventId,
      value: payload.value
    });
    return;
  }

  // Etapa 5 -- aplica a leitura e recalcula o estado.
  const transicao = estado.aplicarLeitura(payload, agora);
  if (transicao.anterior !== transicao.atual) {
    log.registrar(
      'ESTADO',
      `${transicao.anterior} -> ${transicao.atual}` +
        (transicao.descontinuidade ? ' (contagem reiniciada)' : '') +
        ` secas=${estado.consecutivasSecas}/${cfg.regra.amostrasDebounce}`,
      { transicao, resumo: estado.resumo(agora) }
    );
  } else {
    log.registrar(
      'ACEITO',
      `${transicao.atual} secas=${estado.consecutivasSecas}/${cfg.regra.amostrasDebounce}`,
      { resumo: estado.resumo(agora) }
    );
  }

  avaliarEAtuar(agora);
}

function tratarHeartbeat(payload, agora) {
  const valido = contrato.validar('EstadoConectividade', payload);
  if (!valido.ok) {
    log.registrar('REJEITADO', `heartbeat ${valido.motivo}: ${valido.detalhe || ''}`, {
      motivo: valido.motivo
    });
    return;
  }

  /*
   * state OFFLINE so pode ter vindo da will message, publicada pelo BROKER
   * quando a conexao do dispositivo terminou sem DISCONNECT. E a diferenca
   * entre "o dispositivo se despediu" e "o dispositivo morreu" -- e e o que
   * torna a queda observavel sem esperar a expiracao por tempo.
   */
  if (payload.state === 'OFFLINE') {
    const t = estado.marcarOffline(payload.reason || 'lwt');
    log.registrar('ESTADO', `${t.anterior} -> ${t.atual} (via LWT do broker: ${t.motivo})`, {
      transicao: t
    });
    avaliarEAtuar(agora);
    return;
  }

  log.registrar('ACEITO', `heartbeat state=${payload.state} silencio=${payload.value}ms`, {
    state: payload.state,
    silencioMs: payload.value
  });
}

function tratarAck(payload) {
  const valido = contrato.validar('ConfirmacaoAtuacao', payload);
  if (!valido.ok) {
    log.registrar('REJEITADO', `ack ${valido.motivo}: ${valido.detalhe || ''}`, {
      motivo: valido.motivo
    });
    return;
  }

  /*
   * Confirmacao de NEGOCIO. O QoS do MQTT ja garantiu que o pacote chegou; este
   * evento diz o que a regra do dispositivo fez com ele. Sao perguntas
   * diferentes, e so a segunda responde "a bomba ligou?".
   */
  const efeito = payload.result === 'EXECUTADO' ? 'efeito aplicado' : 'efeito NAO aplicado';
  log.registrar(
    'ACK',
    `${payload.commandId} -> ${payload.result} (${efeito})` +
      (payload.detail ? ` [${payload.detail}]` : ''),
    {
      commandId: payload.commandId,
      correlationId: payload.correlationId,
      result: payload.result
    }
  );

  /*
   * A confirmacao CORRIGE a suposicao feita na emissao -- ela nao a estabelece.
   *
   * Ao publicar um pulso, o servico ja assume que a agua pode ter sido
   * aplicada (ver publicarComando). Se dependesse do ack para acreditar nisso,
   * um ack perdido deixaria o servico convencido de que nada acontece no vaso,
   * e ele nunca revogaria a irrigacao ao perder a validade do dado. Para uma
   * consequencia FISICA, a suposicao segura diante do silencio e a de que ela
   * ocorreu; a confirmacao serve para desfazer essa suposicao quando o
   * dispositivo informa que nao atuou.
   */
  if (payload.result !== 'EXECUTADO' && payload.result !== 'IGNORADO_DUPLICADO') {
    // REJEITADO_EXPIRADO ou REJEITADO_CONTRATO: o efeito nao ocorreu.
    estado.bombaLigada = false;
  }
}

// ---------------------------------------------------------------------------
// Decisao e publicacao
// ---------------------------------------------------------------------------

function avaliarEAtuar(agora) {
  const { comando, motivoNaoAtuou } = decidir(estado, cfg, agora);

  if (!comando) {
    log.registrar('SEM_ACAO', `nenhum comando emitido (${motivoNaoAtuou})`, {
      motivo: motivoNaoAtuou,
      resumo: estado.resumo(agora)
    });
    return;
  }

  log.registrar(
    'DECISAO',
    `${comando.action} porque ${comando.reason} ` +
      `(valor=${estado.ultimoValor}% estado=${estado.estado})`,
    { comando, resumo: estado.resumo(agora) }
  );

  publicarComando(comando, agora);
}

function publicarComando(comando, agora) {
  // O proprio servico valida o que publica. Produzir fora do contrato e tao
  // grave quanto consumir fora dele.
  const valido = contrato.validar('ComandoIrrigacao', comando);
  if (!valido.ok) {
    log.registrar('REJEITADO', `comando gerado viola o contrato: ${valido.detalhe}`, { comando });
    return;
  }

  cliente.publish(
    topicos.comandoIrrigacao,
    JSON.stringify(comando),
    { qos: cfg.mqtt.qos },
    (erro) => {
      if (erro) {
        log.registrar('REJEITADO', `falha ao publicar ${comando.commandId}: ${erro.message}`);
        return;
      }
      log.registrar(
        'COMANDO',
        `${comando.commandId} publicado -> ${comando.action} ` +
          `(idempotencyKey=${comando.idempotencyKey}, expira em ` +
          `${comando.expiresAtDeviceMs}ms do relogio do dispositivo)`,
        { comando }
      );
    }
  );

  ultimaAcaoEnviada = comando.action;
  ultimoComandoEmitido = comando;
  estado.ultimoComandoEm = agora;

  /*
   * O estado da bomba acompanha a INTENCAO, no instante da emissao, e nao a
   * confirmacao. Publicado um pulso, o servico passa a se considerar
   * responsavel por uma irrigacao em curso -- e por isso capaz de revoga-la se
   * o dado perder validade. O ack apenas corrige essa suposicao para baixo
   * (ver tratarAck).
   */
  estado.bombaLigada = comando.action === 'PULSO_IRRIGACAO';
}

// ---------------------------------------------------------------------------
// Tick de validade
// ---------------------------------------------------------------------------

/*
 * O coracao do recorte de estado temporal: a validade e verificada por TEMPO,
 * nao por chegada de mensagem. Sem este tick, um dispositivo que emudece
 * manteria para sempre o estado AUTORIZADO da ultima leitura.
 */
setInterval(() => {
  const agora = Date.now();
  const transicao = estado.expirarSeNecessario(agora);
  if (transicao) {
    log.registrar(
      'ESTADO',
      `${transicao.anterior} -> ${transicao.atual} (${transicao.motivo}: idade ` +
        `${estado.idadeMs(agora)}ms >= validade ${cfg.regra.validadeMs}ms) -- ` +
        `valor ${estado.ultimoValor}% preservado para diagnostico, autorizacao revogada`,
      { transicao, resumo: estado.resumo(agora) }
    );
    avaliarEAtuar(agora);
  }
}, 500);

// ---------------------------------------------------------------------------
// Introspeccao e encerramento
// ---------------------------------------------------------------------------

/*
 * Pressionar 'e' imprime o estado corrente. Existe para a verificacao oral:
 * quando a pergunta for "onde esta o estado agora?", a resposta e uma tecla.
 */
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (tecla) => {
    const k = tecla.toString();
    if (k === 'e') {
      console.log('');
      console.log(`${CORES.negrito}estado corrente do consumidor${CORES.reset}`);
      console.log(JSON.stringify(estado.resumo(Date.now()), null, 2));
      console.log('');
    }
    if (k === String.fromCharCode(3)) encerrar();
  });
}

function encerrar() {
  log.registrar('CONEXAO', 'encerrando servico');
  log.fechar();
  cliente.end(true, () => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

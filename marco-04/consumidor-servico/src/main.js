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

const path = require('path');
const contrato = require('../../contrato');
const seguranca = require('../../seguranca');
const { EstadoVaso } = require('./estado');
const { AlertasCuidado } = require('./alertas');
const { decidir } = require('./decisao');
const { Log, CORES } = require('./log');
// Marco 4
const { EstadoAmbiente, decidirUmidificador, ESTADOS_AR } = require('./ambiente');
const { EstadoReservatorios, ESTADOS_NIVEL } = require('./reservatorios');
const { VerificacaoIrrigacao } = require('./verificacao');
const { RegraAdubacao } = require('./adubacao');
const { Atuadores } = require('./atuadores');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);
const RAIZ = path.resolve(__dirname, '../..');

const log = new Log(path.join(RAIZ, cfg.log.arquivoJsonl));
const estado = new EstadoVaso(cfg.identidade.vasoId, cfg);

let ultimaAcaoEnviada = null;
let ultimoComandoEmitido = null;

console.log('');
console.log(`${CORES.negrito}servico-irrigacao${CORES.reset} -- consumidor do Marco 4`);
console.log(`  broker      ${cfg.mqtt.url}`);
console.log(`  assina      ${topicos.telemetriaSolo}`);
console.log(`              ${topicos.telemetriaAmbiente}`);
console.log(`              ${topicos.telemetriaReservatorio}`);
console.log(`              ${topicos.heartbeat}`);
console.log(`              ${topicos.ackIrrigacao}`);
console.log(`              ${topicos.ackAtuador}`);
console.log(`  publica     ${topicos.comandoIrrigacao}`);
console.log(`              ${topicos.comandoAtuador}`);
console.log(
  `  regra       liga<${cfg.regra.limiarLiga}% desliga>${cfg.regra.limiarDesliga}% ` +
    `debounce=${cfg.regra.amostrasDebounce} cooldown=${cfg.regra.cooldownMs}ms ` +
    `validade=${cfg.regra.validadeMs}ms ttl=${cfg.regra.comandoTtlMs}ms`
);
console.log(
  `  marco 4     R1 umidificador liga<${cfg.ambiente.umidadeArMin}% desliga>${cfg.ambiente.umidadeArMin + cfg.ambiente.histerese}% | ` +
    `R2 bloqueio reservatorio<=${cfg.reservatorios.nivelCriticoPct}% + verificacao ${cfg.verificacao.janelaMs}ms | ` +
    `R3 adubo EC<${cfg.adubacao.ec25MinUsCm}uS/cm, max ${cfg.adubacao.maxDoses} dose/${cfg.adubacao.janelaDosesMs}ms`
);
console.log(
  `  seguranca   ${cfg.mqtt.url.startsWith('mqtts:') ? 'TLS' : 'SEM TLS'}, ` +
    `${contrato.brokerLocal(cfg.mqtt.url) ? 'identidade servico-irrigacao (usuario/senha)' : 'broker publico: sem senha, so HMAC'}, ` +
    `assinatura HMAC ${cfg.seguranca.exigirAssinatura ? 'EXIGIDA' : 'DESLIGADA'}`
);
console.log('');

// ---------------------------------------------------------------------------
// Conexao
// ---------------------------------------------------------------------------

/*
 * Identidade "servico-irrigacao": TLS + usuario/senha no broker local. Pela ACL,
 * e a UNICA identidade autorizada a publicar comando (ver seguranca/acl.json).
 */
const IDENTIDADE = 'servico-irrigacao';

const cliente = contrato.conectar(cfg, IDENTIDADE, {
  clientId: `${IDENTIDADE}-${Math.random().toString(16).slice(2, 8)}`,
  clean: true
});

const alertas = new AlertasCuidado(cliente, cfg, log);

// Marco 4: estado e regras dos sensores e atuadores novos.
const ambiente = new EstadoAmbiente(cfg);
const reservatorios = new EstadoReservatorios(cfg);
const verificacao = new VerificacaoIrrigacao(cfg);
const atuadores = new Atuadores(cliente, cfg, log, topicos);
const adubacao = new RegraAdubacao(cfg, {
  estadoVaso: estado,
  reservatorios,
  atuadores,
  alertas,
  log,
  irrigacaoBloqueada: (agora) => verificacao.bloqueada(agora) || reservatorios.critico('AGUA')
});

cliente.on('connect', () => {
  log.registrar('CONEXAO', `conectado a ${cfg.mqtt.url}`);
  cliente.subscribe(
    [topicos.telemetriaSolo, topicos.heartbeat, topicos.ackIrrigacao,
      topicos.telemetriaAmbiente, topicos.telemetriaReservatorio, topicos.ackAtuador],
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

  // Etapa 1 -- desserializacao tolerante + autenticidade (HMAC do dispositivo).
  // Toda mensagem assinada aqui vem de dispositivo: telemetria, heartbeat
  // (inclusive o LWT) e ack. Sem assinatura valida, nada segue no pipeline.
  const bruto = contrato.abrirMensagemDeDispositivo(cfg, topico, buffer);
  if (!bruto.ok) {
    log.registrar('REJEITADO', `${bruto.motivo} em ${topico}: ${bruto.detalhe || ''}`, {
      topico,
      motivo: bruto.motivo,
      detalhe: bruto.detalhe
    });
    return;
  }

  if (topico === topicos.telemetriaSolo) return tratarTelemetria(bruto.payload, agora);
  if (topico === topicos.heartbeat) return tratarHeartbeat(bruto.payload, agora);
  if (topico === topicos.ackIrrigacao) return tratarAck(bruto.payload);
  if (topico === topicos.telemetriaAmbiente) return tratarAmbiente(bruto.payload, agora);
  if (topico === topicos.telemetriaReservatorio) return tratarReservatorio(bruto.payload, agora);
  if (topico === topicos.ackAtuador) return tratarAckAtuador(bruto.payload, agora);

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

  // Etapa 3b -- a validacao local do dispositivo veio negativa.
  if (payload.valid === false) {
    const t = estado.marcarLeituraInvalida(payload.invalidReason || 'leitura_invalida');
    log.registrar('ESTADO', `${t.anterior} -> ${t.atual} (${t.motivo})`, { transicao: t });
    // Marco 4: a sonda e uma so -- leitura invalida invalida tambem a EC.
    adubacao.descartarMedia();
    if (t.anterior !== t.atual && payload.ecApparentUsCm !== undefined) {
      alertas.emitir('SENSOR_FALHOU', 'ATENCAO', `Sonda de solo sem leitura valida (${t.motivo}).`, payload.eventId);
    }
    avaliarEAtuar(agora);
    return;
  }

  // Etapa 5 -- aplica a leitura e recalcula o estado.
  const transicao = estado.aplicarLeitura(payload, agora);
  estado.deviceId = payload.deviceId;
  alertas.transicao(transicao, estado, payload);
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

  // Marco 4: a mesma leitura alimenta a adubacao (EC) e a verificacao do
  // efeito da irrigacao. A R3 roda ANTES da R2 para que um pedido de agua
  // ("preparar_adubacao") ja seja considerado nesta mesma avaliacao.
  if (transicao.anterior === 'LEITURA_INVALIDA' && payload.ecApparentUsCm !== undefined) {
    alertas.emitir('SENSOR_RECUPERADO', 'INFO', 'Sonda de solo voltou a ler.', payload.eventId);
  }
  adubacao.registrarLeitura(payload, agora);
  verificarEfeitoIrrigacao(agora);
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
    alertas.transicao(t, estado, payload);
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
  /*
   * So o ack de um comando que ESTE servico emitiu, vindo do dispositivo que o
   * recebeu, corrige o estado. A recusa de um comando forjado por terceiro
   * (REJEITADO_ASSINATURA de um commandId desconhecido) nao diz nada sobre a
   * irrigacao que este servico pediu: confirmar() devolve null para ela.
   */
  const original = alertas.confirmar(payload);
  if (original && original.commandId === ultimoComandoEmitido?.commandId && payload.result !== 'EXECUTADO' && payload.result !== 'IGNORADO_DUPLICADO') {
    // REJEITADO_EXPIRADO, REJEITADO_CONTRATO, REJEITADO_ASSINATURA ou
    // REJEITADO_SEGURANCA (Marco 4): o efeito nao ocorreu.
    estado.bombaLigada = false;
    estado.pulsoAteMs = 0;
  }

  /*
   * Marco 4: com o pulso EXECUTADO, comeca a verificacao do EFEITO -- mas so se
   * o vaso publica nivel de reservatorio (sem ele nao ha validacao cruzada).
   */
  if (original && original.action === 'PULSO_IRRIGACAO' && payload.result === 'EXECUTADO' &&
      reservatorios.visto('AGUA') && !estado.emFalha()) {
    const iniciou = verificacao.iniciar(original.commandId, estado.ultimoValor,
      reservatorios.nivelConfiavel('AGUA'), Date.now());
    if (iniciou) {
      log.registrar('VERIFICACAO', `${original.commandId}: aguardando efeito (umidade ${estado.ultimoValor}% ` +
        `deve subir ${cfg.verificacao.deltaUmidadePct} pts e nivel ${reservatorios.nivelConfiavel('AGUA')}% ` +
        `deve cair ${cfg.verificacao.deltaNivelPct} pt em ${cfg.verificacao.janelaMs}ms)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Marco 4 -- telemetria de ambiente e de reservatorio, acks de atuador
// ---------------------------------------------------------------------------

/*
 * Etapas comuns as telemetrias novas: contrato, deduplicacao (o mesmo conjunto
 * de eventIds do solo -- o sequence e unico entre os tres eventos) e evento
 * historico. Devolve true se a leitura deve seguir para a regra.
 */
function admitirTelemetria(tipo, payload) {
  const valido = contrato.validar(tipo, payload);
  if (!valido.ok) {
    log.registrar('REJEITADO', `${tipo} ${valido.motivo}: ${valido.detalhe || ''}`, { motivo: valido.motivo, payload });
    return false;
  }
  if (estado.jaVisto(payload.eventId)) {
    log.registrar('DUPLICADO', `${payload.eventId} ja processado -- descartado`, { eventId: payload.eventId });
    return false;
  }
  estado.registrarEventId(payload.eventId);
  if (payload.replayed === true) {
    log.registrar('HISTORICO', `${tipo} ${payload.eventId} arquivado (nao decide)`, { eventId: payload.eventId });
    return false;
  }
  return true;
}

function tratarAmbiente(payload, agora) {
  if (!admitirTelemetria('LeituraAmbiente', payload)) return;
  log.registrar('RECEBIDO', `${payload.eventId} ar ` +
    (payload.valid ? `${payload.humidityPct}% ${payload.temperatureC}C` : `invalido (${payload.invalidReason || '-'})`),
    { eventId: payload.eventId });

  const t = ambiente.aplicar(payload, agora);
  if (t.anterior !== t.atual) {
    log.registrar('ESTADO', `ar ${t.anterior} -> ${t.atual}`, { transicao: t, resumo: ambiente.resumo() });
    if (t.atual === ESTADOS_AR.INVALIDO) {
      alertas.emitir('SENSOR_FALHOU', 'ATENCAO', `Sensor de ar (DHT22) sem leitura valida (${t.motivo || 'invalido'}). Umidificador desligado por seguranca.`, payload.eventId);
    } else if (t.anterior === ESTADOS_AR.INVALIDO && t.atual === ESTADOS_AR.NORMAL) {
      alertas.emitir('SENSOR_RECUPERADO', 'INFO', 'Sensor de ar (DHT22) voltou a ler.', payload.eventId);
    }
  }
  avaliarUmidificador(agora);
}

function avaliarUmidificador(agora) {
  const { acao, motivo } = decidirUmidificador(ambiente, cfg, agora);
  if (!acao) return;
  const origem = { eventId: ambiente.ultimoEventId, eventTimeMs: ambiente.ultimoEventTimeMs, deviceId: ambiente.deviceId };
  const cmd = atuadores.publicar('UMIDIFICADOR', acao, motivo, origem,
    acao === 'LIGAR' ? cfg.ambiente.concessaoMs : undefined);
  if (!cmd) return;
  // Estado acompanha a INTENCAO na emissao (mesma politica da bomba no Marco 3);
  // o ack so corrige para baixo.
  if (acao === 'LIGAR') {
    if (!ambiente.umidificadorLigado) ambiente.ultimaMudancaEm = agora;
    ambiente.umidificadorLigado = true;
    ambiente.ultimaConcessaoEm = agora;
  } else {
    ambiente.umidificadorLigado = false;
    ambiente.ultimaMudancaEm = agora;
  }
}

function tratarReservatorio(payload, agora) {
  if (!admitirTelemetria('NivelReservatorio', payload)) return;
  const t = reservatorios.aplicar(payload, agora);
  const nome = payload.reservoir === 'AGUA' ? 'de agua' : 'de fertilizante';
  log.registrar(t.anterior !== t.atual ? 'ESTADO' : 'ACEITO',
    `reservatorio ${payload.reservoir} ${t.anterior} -> ${t.atual}` +
      (payload.valid ? ` (${payload.levelPct}%)` : ` (invalido: ${payload.invalidReason || '-'})`),
    { transicao: t });

  if (t.anterior !== t.atual) {
    if (t.atual === ESTADOS_NIVEL.CRITICO) {
      alertas.emitir('RESERVATORIO_CRITICO', 'CRITICO',
        `Reservatorio ${nome} em ${payload.levelPct}%: a bomba fica bloqueada ate reabastecer.`, payload.eventId);
    } else if (t.atual === ESTADOS_NIVEL.BAIXO && t.anterior !== ESTADOS_NIVEL.CRITICO) {
      alertas.emitir('RESERVATORIO_BAIXO', 'ATENCAO', `Reservatorio ${nome} em ${payload.levelPct}%. Reabastecer em breve.`, payload.eventId);
    } else if (t.atual === ESTADOS_NIVEL.OK && [ESTADOS_NIVEL.BAIXO, ESTADOS_NIVEL.CRITICO].includes(t.anterior)) {
      alertas.emitir('RESERVATORIO_NORMALIZADO', 'INFO', `Reservatorio ${nome} reabastecido (${payload.levelPct}%).`, payload.eventId);
    } else if (t.atual === ESTADOS_NIVEL.INVALIDO) {
      alertas.emitir('SENSOR_FALHOU', 'ATENCAO', `Sensor de nivel do reservatorio ${nome} sem leitura valida.`, payload.eventId);
    } else if (t.anterior === ESTADOS_NIVEL.INVALIDO) {
      alertas.emitir('SENSOR_RECUPERADO', 'INFO', `Sensor de nivel do reservatorio ${nome} voltou a ler.`, payload.eventId);
    }
  }
  verificarEfeitoIrrigacao(agora);
  adubacao.avaliar(agora);
  // Reservatorio de agua ficou critico com a bomba ligada: PARAR na hora.
  if (payload.reservoir === 'AGUA' && t.anterior !== t.atual) avaliarEAtuar(agora);
}

function tratarAckAtuador(payload, agora) {
  const valido = contrato.validar('ConfirmacaoAtuacao', payload);
  if (!valido.ok) {
    log.registrar('REJEITADO', `ack atuador ${valido.motivo}: ${valido.detalhe || ''}`, { motivo: valido.motivo });
    return;
  }
  log.registrar('ACK', `${payload.commandId} -> ${payload.result}` + (payload.detail ? ` [${payload.detail}]` : ''),
    { commandId: payload.commandId, result: payload.result });

  const original = atuadores.confirmar(payload);
  if (!original) return;

  if (original.actuator === 'BOMBA_ADUBO') {
    adubacao.aoConfirmar(original, payload, agora);
    return;
  }
  // UMIDIFICADOR
  if (payload.result === 'EXECUTADO') {
    if (original.action === 'LIGAR' && original.reason !== 'renovacao_concessao') {
      alertas.emitir('UMIDIFICADOR_ACIONADO', 'INFO',
        `Umidificador ligado: umidade do ar abaixo de ${cfg.ambiente.umidadeArMin}%.`, original.commandId);
    }
  } else if (original.action === 'LIGAR') {
    ambiente.umidificadorLigado = false;
    ambiente.ultimaMudancaEm = agora;
    alertas.emitir('ATUACAO_RECUSADA', 'ATENCAO',
      `Umidificador nao ligou: ${payload.result}${payload.detail ? ` (${payload.detail})` : ''}.`, original.commandId);
  }
}

/* R2 -- validacao cruzada do efeito do ultimo pulso de agua. */
function verificarEfeitoIrrigacao(agora) {
  const r = verificacao.avaliar(estado.emFalha() ? null : estado.ultimoValor,
    reservatorios.nivelConfiavel('AGUA'), agora);
  if (!r) return;
  if (r.resultado === 'CONFIRMADO') {
    log.registrar('VERIFICACAO', `${r.commandId}: efeito confirmado (umidade subiu e nivel caiu)`);
    return;
  }
  log.registrar('VERIFICACAO', `${r.commandId}: SEM efeito (${r.diagnostico}) -- irrigacao automatica bloqueada`);
  alertas.emitir('FALHA_IRRIGACAO', 'CRITICO',
    `Irrigacao sem efeito confirmado (${r.diagnostico}). Irrigacao automatica bloqueada ate reconhecimento.`, r.commandId);
  avaliarEAtuar(agora);
}

/* O que as regras do Marco 4 dizem a R2 (ver decidir()). */
function contextoIrrigacao(agora) {
  const bloqueio = reservatorios.critico('AGUA') ? 'reservatorio_agua_critico'
    : verificacao.bloqueada(agora) ? 'irrigacao_bloqueada_sem_efeito'
    : adubacao.bloqueioIrrigacao(agora);
  return { bloqueio, pedido: adubacao.pedidoIrrigacao() };
}

// ---------------------------------------------------------------------------
// Decisao e publicacao
// ---------------------------------------------------------------------------

let ultimoContexto = '';

function avaliarEAtuar(agora) {
  const ctx = contextoIrrigacao(agora);
  ultimoContexto = JSON.stringify(ctx);
  const { comando, motivoNaoAtuou } = decidir(estado, cfg, agora, ctx);

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

  /*
   * O comando sai assinado com a chave do dispositivo que vai executa-lo -- o
   * mesmo que enviou a telemetria que originou a decisao. Do lado dele, comando
   * sem essa assinatura e recusado antes de qualquer outra verificacao: e o que
   * impede um terceiro no broker publico de ligar a bomba.
   */
  const disp = seguranca.dispositivo(estado.deviceId);
  if (!disp) {
    log.registrar('REJEITADO', `sem chave para assinar o comando (deviceId=${estado.deviceId})`, { comando });
    return;
  }
  const texto = seguranca.assinar(disp.chave, topicos.comandoIrrigacao, comando);

  alertas.registrarComando({ ...comando, deviceIdOrigem: estado.deviceId, bootIdOrigem: estado.bootId });
  cliente.publish(
    topicos.comandoIrrigacao,
    texto,
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
  // Marco 4: fim estimado do pulso fisico, para o intertravamento com a bomba
  // de adubo (margem de 1 s para o atraso da rede).
  estado.pulsoAteMs = comando.action === 'PULSO_IRRIGACAO' ? agora + comando.durationMs + 1000 : 0;
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
    alertas.transicao(transicao, estado);
    log.registrar(
      'ESTADO',
      `${transicao.anterior} -> ${transicao.atual} (${transicao.motivo}: idade ` +
        `${estado.idadeMs(agora)}ms >= validade ${cfg.regra.validadeMs}ms) -- ` +
        `valor ${estado.ultimoValor}% preservado para diagnostico, autorizacao revogada`,
      { transicao, resumo: estado.resumo(agora) }
    );
    adubacao.descartarMedia();
    avaliarEAtuar(agora);
  }

  // Marco 4: validade do ar e dos reservatorios, verificacao de efeito,
  // maquina da adubacao e renovacao da concessao do umidificador -- tudo por
  // TEMPO, nao por chegada de mensagem.
  const tAr = ambiente.expirarSeNecessario(agora);
  if (tAr) {
    log.registrar('ESTADO', `ar ${tAr.anterior} -> ${tAr.atual} (${tAr.motivo})`, { transicao: tAr });
    // Pode chegar tarde ao dispositivo (prazo ancorado no ultimo evento): por
    // isso o LIGAR e uma concessao -- o umidificador desliga de qualquer jeito.
    avaliarUmidificador(agora);
  }
  for (const tr of reservatorios.expirarSeNecessario(agora)) {
    log.registrar('ESTADO', `reservatorio ${tr.reservatorio} ${tr.anterior} -> ${tr.atual} (${tr.motivo})`, { transicao: tr });
  }
  verificarEfeitoIrrigacao(agora);
  adubacao.avaliar(agora);
  // Um bloqueio ou pedido que surgiu so por tempo tambem precisa chegar a R2.
  if (JSON.stringify(contextoIrrigacao(agora)) !== ultimoContexto) avaliarEAtuar(agora);
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
      const agora = Date.now();
      console.log(JSON.stringify({
        solo: estado.resumo(agora),
        ar: ambiente.resumo(),
        reservatorios: reservatorios.resumo(),
        verificacaoIrrigacao: verificacao.resumo(),
        adubacao: adubacao.resumo(agora)
      }, null, 2));
      console.log('');
    }
    // Marco 4: reconhecimento de falha (o lugar do botao do aplicativo).
    if (k === 'r') {
      const agora = Date.now();
      verificacao.liberar();
      const adubo = adubacao.reconhecer(agora);
      log.registrar('ESTADO', `falhas reconhecidas pelo usuario (irrigacao liberada${adubo ? ', adubacao liberada' : ''})`);
      avaliarEAtuar(agora);
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

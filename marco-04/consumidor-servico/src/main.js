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
const { decidir, contadorAtual, restaurarContador } = require('./decisao');
const { Log, CORES } = require('./log');
// Marco 4: persistencia (TimescaleDB) e perfil de cuidado por especie/grupo/vaso
const { Persistencia } = require('../../persistencia');
const perfil = require('../../persistencia/perfil');
// Marco 4
const { EstadoAmbiente, decidirUmidificador, ESTADOS_AR } = require('./ambiente');
const { EstadoReservatorios, ESTADOS_NIVEL } = require('./reservatorios');
const { VerificacaoIrrigacao } = require('./verificacao');
const { RegraAdubacao } = require('./adubacao');
const { Atuadores } = require('./atuadores');
const { EstadoLuz, ESTADOS_LUZ } = require('./luz');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);
const RAIZ = path.resolve(__dirname, '../..');

const log = new Log(path.join(RAIZ, cfg.log.arquivoJsonl));
const estado = new EstadoVaso(cfg.identidade.vasoId, cfg);
const persistencia = new Persistencia(cfg, { log });
// Valores do config.json (+ ambiente) ANTES de qualquer perfil: a base sobre a
// qual especie, grupo e vaso sao recombinados a cada recarga.
const PADRAO_PERFIL = perfil.capturarPadrao(cfg);
const CHAVE_ESTADO = `vaso:${cfg.identidade.vasoId}`;
// Fica true depois de restaurar estado e perfil: so entao o tick decide.
let servicoPronto = false;

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
console.log(`              ${topicos.solicitacaoApp}  (app)`);
console.log(`              ${topicos.telemetriaLuz}  (app: sensor de luz do celular)`);
console.log(`  publica     ${topicos.comandoIrrigacao}`);
console.log(`              ${topicos.comandoAtuador}`);
console.log(`              ${topicos.estadoVaso}  (retido, para o app)`);
console.log(`              ${topicos.respostaApp}  (app)`);
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

/*
 * manualConnect: o servico so entra no broker DEPOIS de restaurar o estado
 * salvo e o perfil do vaso (ver partida(), no fim do arquivo). Decidir antes
 * disso seria decidir sem saber quantas doses ja foram aplicadas.
 */
const cliente = contrato.conectar(cfg, IDENTIDADE, {
  clientId: `${IDENTIDADE}-${Math.random().toString(16).slice(2, 8)}`,
  clean: true,
  manualConnect: true
});

const alertas = new AlertasCuidado(cliente, cfg, log, persistencia);

// Marco 4: estado e regras dos sensores e atuadores novos.
const ambiente = new EstadoAmbiente(cfg);
const reservatorios = new EstadoReservatorios(cfg);
const verificacao = new VerificacaoIrrigacao(cfg);
const luz = new EstadoLuz(cfg);
const atuadores = new Atuadores(cliente, cfg, log, topicos, persistencia);
const adubacao = new RegraAdubacao(cfg, {
  estadoVaso: estado,
  reservatorios,
  atuadores,
  alertas,
  log,
  irrigacaoBloqueada: (agora) => verificacao.bloqueada(agora) || reservatorios.critico('AGUA'),
  aoMudar: (t) => gravarTransicao('adubacao', t)
});

// ---------------------------------------------------------------------------
// Marco 4 -- gravacao do historico
// ---------------------------------------------------------------------------

/* Transicao de estado de uma regra -> hypertable `transicoes`. */
function gravarTransicao(componente, t) {
  if (!t || t.anterior === t.atual) return;
  persistencia.gravar('transicoes', {
    componente,
    anterior: t.anterior === undefined || t.anterior === null ? null : String(t.anterior),
    atual: String(t.atual),
    motivo: t.motivo || null
  });
}

/* Campos comuns a toda telemetria aceita (inclusive invalida e replayed). */
function colunasEvento(p) {
  return {
    device_id: p.deviceId, boot_id: p.bootId ?? null, event_id: p.eventId,
    sequence: p.sequence ?? null, event_time_ms: p.eventTimeMs ?? null,
    valida: p.valid !== false, motivo_invalido: p.invalidReason || null,
    replayed: p.replayed === true
  };
}

function gravarTelemetria(tipo, p) {
  if (tipo === 'LeituraUmidadeSolo') {
    persistencia.gravar('telemetria_solo', {
      ...colunasEvento(p), umidade_pct: p.value ?? null, solo_temp_c: p.soilTempC ?? null,
      ec_aparente_us_cm: p.ecApparentUsCm ?? null, ec25_us_cm: p.ec25UsCm ?? null, ec_valida: p.ecValid ?? null
    });
  } else if (tipo === 'LeituraAmbiente') {
    persistencia.gravar('telemetria_ambiente', {
      ...colunasEvento(p), umidade_ar_pct: p.humidityPct ?? null, temperatura_c: p.temperatureC ?? null
    });
  } else if (tipo === 'NivelReservatorio') {
    persistencia.gravar('telemetria_reservatorio', {
      ...colunasEvento(p), reservatorio: p.reservoir, nivel_pct: p.levelPct ?? null, distancia_cm: p.distanceCm ?? null
    });
  }
}

function gravarConfirmacao(p, topico) {
  persistencia.gravar('confirmacoes', {
    command_id: p.commandId, device_id: p.deviceId ?? null, correlation_id: p.correlationId ?? null,
    resultado: p.result, detalhe: p.detail || null, topico
  });
}

cliente.on('connect', () => {
  log.registrar('CONEXAO', `conectado a ${cfg.mqtt.url}`);
  cliente.subscribe(
    [topicos.telemetriaSolo, topicos.heartbeat, topicos.ackIrrigacao,
      topicos.telemetriaAmbiente, topicos.telemetriaReservatorio, topicos.ackAtuador,
      topicos.solicitacaoApp, topicos.telemetriaLuz],
    { qos: cfg.mqtt.qos },
    (erro) => {
      if (erro) log.registrar('REJEITADO', `falha ao assinar: ${erro.message}`);
      else log.registrar('CONEXAO', `assinaturas ativas (QoS ${cfg.mqtt.qos})`);
    }
  );
  // Marco 4: quem abrir o app agora ja encontra o estado corrente retido.
  publicarEstadoVaso(Date.now(), true);
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

  // Marco 4: mensagens do APP. No broker do grupo a origem e garantida pelo
  // broker (so a identidade `app` do vaso publica nestes topicos, acl.json);
  // no broker publico, pelo HMAC do proprio app (contrato.abrirMensagemDoApp).
  if (topico === topicos.solicitacaoApp) return tratarSolicitacaoApp(topico, buffer, agora);
  if (topico === topicos.telemetriaLuz) return tratarLuz(topico, buffer, agora);

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
  // Marco 4: toda leitura aceita vira historico -- inclusive a invalida e a
  // replayed (medida durante a queda: nao decide, mas e dado real do vaso).
  gravarTelemetria('LeituraUmidadeSolo', payload);

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
    gravarTransicao('solo', t);
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
  gravarTransicao('solo', { ...transicao, motivo: transicao.descontinuidade ? 'contagem_reiniciada' : null });
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
    gravarTransicao('solo', t);
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
  gravarConfirmacao(payload, 'ack/irrigacao');

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
  gravarTelemetria(tipo, payload);
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
    gravarTransicao('ar', t);
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
    gravarTransicao(`reservatorio_${payload.reservoir}`, t);
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
  gravarConfirmacao(payload, 'ack/atuador');

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

// ---------------------------------------------------------------------------
// Marco 4 -- R5: luz medida pelo sensor do celular (o app como produtor)
// ---------------------------------------------------------------------------

function tratarLuz(topico, buffer, agora) {
  const bruto = contrato.abrirMensagemDoApp(cfg, topico, buffer);
  if (!bruto.ok) {
    log.registrar('REJEITADO', `LeituraLuz ${bruto.motivo}: ${bruto.detalhe || ''}`);
    return;
  }
  const p = bruto.payload;
  const valido = contrato.validar('LeituraLuz', p);
  if (!valido.ok) {
    log.registrar('REJEITADO', `LeituraLuz ${valido.motivo}: ${valido.detalhe || ''}`, { motivo: valido.motivo, payload: p });
    return;
  }
  if (p.entityId !== cfg.identidade.vasoId) {
    log.registrar('REJEITADO', `LeituraLuz de outro vaso (${p.entityId})`);
    return;
  }
  if (estado.jaVisto(p.eventId)) {
    log.registrar('DUPLICADO', `${p.eventId} ja processado -- descartado`, { eventId: p.eventId });
    return;
  }
  estado.registrarEventId(p.eventId);

  /*
   * Atraso: a leitura descreve o instante measuredAt. Se chega mais velha que a
   * validade (fila do celular, rede lenta), e historico -- vai para o banco, mas
   * nao entra na media. Relogio do celular adiantado demais tambem nao decide.
   */
  const idade = agora - Date.parse(p.measuredAt);
  const atrasada = idade > cfg.luz.validadeMs;
  const adiantada = -idade > cfg.app.toleranciaRelogioMs;
  persistencia.gravar('telemetria_luz', {
    device_id: p.deviceId, event_id: p.eventId, sequence: p.sequence, measured_at: new Date(p.measuredAt),
    lux: p.lux ?? null, amostras: p.samples ?? null, valida: p.valid !== false,
    motivo_invalido: p.invalidReason || null, atrasada: atrasada || adiantada
  });
  if (atrasada || adiantada) {
    log.registrar('HISTORICO', `LeituraLuz ${p.eventId} ${atrasada ? `chegou ${idade}ms depois de medida` : 'com relogio adiantado'} (arquivada, nao decide)`,
      { eventId: p.eventId, idadeMs: idade });
    return;
  }
  log.registrar('RECEBIDO', `${p.eventId} luz ${p.valid ? `${Math.round(p.lux)} lux (${p.samples ?? '-'} amostras)` : `invalida (${p.invalidReason || '-'})`}`,
    { eventId: p.eventId, lux: p.lux });
  tratarTransicaoLuz(luz.aplicar(p, agora), p.eventId);
}

function tratarTransicaoLuz(t, origem) {
  if (!t) return;
  const media = luz.media();
  const lux = media === null ? '-' : Math.round(media);
  log.registrar('ESTADO', `luz ${t.anterior} -> ${t.atual} (${t.motivo}; media ${lux} lux)`, { transicao: t });
  gravarTransicao('luz', t);
  const correlacao = origem || luz.ultimoEventId || 'luz';
  if (t.atual === ESTADOS_LUZ.POUCA_LUZ) {
    alertas.emitir('LUZ_INSUFICIENTE', 'ATENCAO',
      `Pouca luz: media de ${lux} lux (minimo ${cfg.luz.luxMin}). Leve o vaso para perto de uma janela, sem sol direto.`, correlacao);
  } else if (t.atual === ESTADOS_LUZ.LUZ_EXCESSIVA) {
    alertas.emitir('LUZ_EXCESSIVA', 'ATENCAO',
      `Luz forte demais: media de ${lux} lux (maximo ${cfg.luz.luxMax}). O solo seca mais rapido e as folhas podem queimar.`, correlacao);
  } else if (t.atual === ESTADOS_LUZ.ADEQUADA &&
    [ESTADOS_LUZ.POUCA_LUZ, ESTADOS_LUZ.LUZ_EXCESSIVA].includes(t.anterior)) {
    alertas.emitir('LUZ_NORMALIZADA', 'INFO', `Luz adequada de novo: media de ${lux} lux.`, correlacao);
  }
  publicarEstadoVaso(Date.now(), true);
}

/* R2 -- validacao cruzada do efeito do ultimo pulso de agua. */
function verificarEfeitoIrrigacao(agora) {
  const r = verificacao.avaliar(estado.emFalha() ? null : estado.ultimoValor,
    reservatorios.nivelConfiavel('AGUA'), agora);
  if (!r) return;
  if (r.resultado === 'CONFIRMADO') {
    log.registrar('VERIFICACAO', `${r.commandId}: efeito confirmado (umidade subiu e nivel caiu)`);
    gravarTransicao('verificacao', { anterior: 'EM_CURSO', atual: 'CONFIRMADO', motivo: r.commandId });
    return;
  }
  log.registrar('VERIFICACAO', `${r.commandId}: SEM efeito (${r.diagnostico}) -- irrigacao automatica bloqueada`);
  gravarTransicao('verificacao', { anterior: 'EM_CURSO', atual: 'BLOQUEADA', motivo: `${r.commandId}:${r.diagnostico}` });
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
// Marco 4 -- aplicativo: estado corrente, reconhecimento de falha
// ---------------------------------------------------------------------------

/*
 * Reconhecimento de falha: o usuario viu FALHA_IRRIGACAO / FALHA_ADUBACAO e
 * libera as regras bloqueadas. Chamado pela tecla `r` do servico e pela
 * SolicitacaoApp RECONHECER_FALHA -- a mesma funcao, para que o app nao tenha
 * um caminho com regra diferente da demonstracao no terminal.
 */
function reconhecerFalhas(agora, origem) {
  const irrigacao = verificacao.bloqueada(agora);
  if (irrigacao) verificacao.liberar();
  const adubo = adubacao.reconhecer(agora);
  if (!irrigacao && !adubo) {
    log.registrar('ESTADO', `reconhecimento (${origem}): nenhuma falha pendente`);
    return { irrigacao: false, adubacao: false };
  }
  const liberadas = [irrigacao && 'irrigacao', adubo && 'adubacao'].filter(Boolean).join(' e ');
  log.registrar('ESTADO', `falhas reconhecidas (${origem}): ${liberadas} liberada(s)`);
  if (irrigacao) gravarTransicao('verificacao', { anterior: 'BLOQUEADA', atual: 'LIBERADA', motivo: `reconhecida:${origem}` });
  avaliarEAtuar(agora);
  publicarEstadoVaso(agora, true);
  return { irrigacao, adubacao: adubo };
}

/* Fotografia do estado do servico, no contrato EstadoVaso. */
function montarEstadoVaso(agora) {
  const ar = ambiente.resumo();
  const res = reservatorios.resumo();
  const adubo = adubacao.resumo(agora);
  const ctx = contextoIrrigacao(agora);
  const idade = estado.idadeMs(agora);
  const reservatorio = (r) => ({ estado: r.estado, nivelPct: r.nivelPct ?? null });
  // O que o reconhecimento libera -- nao o bloqueio efetivo (ctx.bloqueio), que
  // pode ser, por exemplo, um reservatorio critico.
  const falhas = [verificacao.bloqueada(agora) && 'IRRIGACAO', adubacao.estado === 'BLOQUEADA' && 'ADUBACAO'].filter(Boolean);
  return {
    schemaVersion: 1,
    eventType: 'EstadoVaso',
    producerId: 'servico-irrigacao',
    entityId: cfg.identidade.vasoId,
    generatedAt: new Date(agora).toISOString(),
    publishIntervalMs: cfg.app.estadoIntervaloMs,
    solo: {
      estado: estado.estado,
      umidadePct: estado.ultimoValor ?? null,
      idadeMs: idade === null ? null : Math.max(0, Math.round(idade)),
      bombaLigada: Boolean(estado.bombaLigada),
      autorizado: Boolean(estado.autorizado())
    },
    ar: {
      estado: ar.estado,
      umidadePct: ar.umidadeArMedia ?? null,
      temperaturaC: ar.temperatura ?? null,
      umidificadorLigado: Boolean(ar.umidificadorLigado)
    },
    reservatorios: { AGUA: reservatorio(res.AGUA), ADUBO: reservatorio(res.ADUBO) },
    irrigacao: { bloqueada: ctx.bloqueio !== null && ctx.bloqueio !== undefined, motivo: ctx.bloqueio || null },
    adubacao: {
      estado: adubo.estado,
      ec25UsCm: adubo.ecMedia ?? null,
      dosesNaJanela: adubo.dosesNaJanela,
      excesso: Boolean(adubo.excesso)
    },
    luz: (() => {
      const r = luz.resumo(agora);
      return { estado: r.estado, luxMedia: r.luxMedia, idadeMs: r.idadeMs === null ? null : Math.max(0, Math.round(r.idadeMs)) };
    })(),
    falhaPendente: falhas.length > 0,
    falhasPendentes: falhas
  };
}

let ultimoEstadoPublicado = '';
let estadoPublicadoEm = 0;

/*
 * Publica o EstadoVaso RETIDO quando algo muda (ignorando a idade, que muda
 * sempre) ou, sem mudanca, a cada estadoIntervaloMs -- o "pulso" que deixa o
 * app distinguir "nada mudou" de "o servico parou".
 */
function publicarEstadoVaso(agora, forcar) {
  if (!servicoPronto || !cliente.connected) return;
  const ev = montarEstadoVaso(agora);
  const chave = JSON.stringify({ ...ev, generatedAt: null, solo: { ...ev.solo, idadeMs: null } });
  if (!forcar && chave === ultimoEstadoPublicado && agora - estadoPublicadoEm < cfg.app.estadoIntervaloMs) return;
  const valido = contrato.validar('EstadoVaso', ev);
  if (!valido.ok) {
    log.registrar('REJEITADO', `EstadoVaso gerado viola o contrato: ${valido.detalhe}`);
    return;
  }
  ultimoEstadoPublicado = chave;
  estadoPublicadoEm = agora;
  cliente.publish(topicos.estadoVaso, contrato.textoAssinadoParaApp(topicos.estadoVaso, ev), { qos: cfg.mqtt.qos, retain: true });
}

/*
 * Idempotencia do pedido: requestId ja tratado devolve IGNORADA_DUPLICADA (com
 * o resultado original no detail) e nao repete o efeito. Em memoria: depois de
 * um reinicio do servico, um retry antigo ja estaria expirado pelo ttlMs.
 */
const respostasApp = new Map();
const MAX_RESPOSTAS_APP = 500;

function responderApp(requestId, action, result, detail, extra) {
  const resposta = {
    schemaVersion: 1,
    eventType: 'RespostaApp',
    producerId: 'servico-irrigacao',
    entityId: cfg.identidade.vasoId,
    requestId,
    ...(action ? { action } : {}),
    result,
    detail,
    ...(extra || {}),
    respondedAt: new Date().toISOString()
  };
  const valido = contrato.validar('RespostaApp', resposta);
  if (!valido.ok) {
    log.registrar('REJEITADO', `RespostaApp gerada viola o contrato: ${valido.detalhe}`);
    return null;
  }
  cliente.publish(topicos.respostaApp, contrato.textoAssinadoParaApp(topicos.respostaApp, resposta), { qos: cfg.mqtt.qos });
  log.registrar('APP', `${requestId} ${action || '?'} -> ${result}${detail ? ` (${detail})` : ''}`, { resposta });
  return resposta;
}

function tratarSolicitacaoApp(topico, buffer, agora) {
  // Sem autenticidade nao ha resposta: responder a um pedido forjado so
  // ensinaria o atacante. Fica registrado no log.
  const bruto = contrato.abrirMensagemDoApp(cfg, topico, buffer);
  if (!bruto.ok) {
    log.registrar('REJEITADO', `app ${bruto.motivo}: ${bruto.detalhe || ''}`);
    return;
  }
  const p = bruto.payload;
  // Sem requestId utilizavel nao ha a quem responder: so registra.
  const requestId = p && typeof p.requestId === 'string' && p.requestId.length >= 1 && p.requestId.length <= 64
    ? p.requestId : null;

  const valido = contrato.validar('SolicitacaoApp', p);
  if (!valido.ok) {
    log.registrar('REJEITADO', `app ${valido.motivo}: ${valido.detalhe || ''}`, { payload: p });
    if (requestId) responderApp(requestId, null, 'REJEITADA_CONTRATO', `${valido.motivo}: ${valido.detalhe || ''}`.trim());
    return;
  }
  if (p.entityId !== cfg.identidade.vasoId) {
    responderApp(requestId, p.action, 'REJEITADA_CONTRATO', `entityId ${p.entityId} nao e o vaso deste topico`);
    return;
  }

  const anterior = respostasApp.get(requestId);
  if (anterior) {
    responderApp(requestId, p.action, 'IGNORADA_DUPLICADA', `resultado original: ${anterior.result}`);
    return;
  }

  // Prazo: o usuario pode ter desistido; e relogio adiantado nao estica o prazo.
  const idade = agora - Date.parse(p.createdAt);
  let resposta;
  if (idade > p.ttlMs) {
    resposta = responderApp(requestId, p.action, 'REJEITADA_EXPIRADA', `chegou ${idade}ms apos createdAt (ttl ${p.ttlMs}ms)`);
  } else if (-idade > cfg.app.toleranciaRelogioMs) {
    resposta = responderApp(requestId, p.action, 'REJEITADA_EXPIRADA',
      `createdAt ${-idade}ms no futuro (relogio do celular adiantado; tolerancia ${cfg.app.toleranciaRelogioMs}ms)`);
  } else {
    const liberou = reconhecerFalhas(agora, `app:${p.deviceId}:${requestId}`);
    resposta = liberou.irrigacao || liberou.adubacao
      ? responderApp(requestId, p.action, 'EXECUTADA',
        [liberou.irrigacao && 'irrigacao liberada', liberou.adubacao && 'adubacao liberada'].filter(Boolean).join(', '),
        { liberou })
      : responderApp(requestId, p.action, 'NADA_A_RECONHECER', 'nenhuma regra bloqueada por falha');
  }

  if (resposta) {
    respostasApp.set(requestId, resposta);
    if (respostasApp.size > MAX_RESPOSTAS_APP) respostasApp.delete(respostasApp.keys().next().value);
  }
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
  persistencia.gravar('comandos', {
    command_id: comando.commandId, tipo: 'ComandoIrrigacao', atuador: 'BOMBA_AGUA', acao: comando.action,
    motivo: comando.reason || null, correlation_id: comando.correlationId || null,
    duracao_ms: comando.durationMs ?? null, device_id: estado.deviceId, payload: comando
  });
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
  if (!servicoPronto) return;
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
    gravarTransicao('solo', transicao);
    adubacao.descartarMedia();
    avaliarEAtuar(agora);
  }

  // Marco 4: validade do ar e dos reservatorios, verificacao de efeito,
  // maquina da adubacao e renovacao da concessao do umidificador -- tudo por
  // TEMPO, nao por chegada de mensagem.
  const tAr = ambiente.expirarSeNecessario(agora);
  if (tAr) {
    log.registrar('ESTADO', `ar ${tAr.anterior} -> ${tAr.atual} (${tAr.motivo})`, { transicao: tAr });
    gravarTransicao('ar', tAr);
    // Pode chegar tarde ao dispositivo (prazo ancorado no ultimo evento): por
    // isso o LIGAR e uma concessao -- o umidificador desliga de qualquer jeito.
    avaliarUmidificador(agora);
  }
  for (const tr of reservatorios.expirarSeNecessario(agora)) {
    log.registrar('ESTADO', `reservatorio ${tr.reservatorio} ${tr.anterior} -> ${tr.atual} (${tr.motivo})`, { transicao: tr });
    gravarTransicao(`reservatorio_${tr.reservatorio}`, tr);
  }
  // Marco 4, R5: validade da luz e tempo minimo da faixa -- por TEMPO.
  tratarTransicaoLuz(luz.expirarSeNecessario(agora));
  tratarTransicaoLuz(luz.avaliar(agora));
  verificarEfeitoIrrigacao(agora);
  adubacao.avaliar(agora);
  // Um bloqueio ou pedido que surgiu so por tempo tambem precisa chegar a R2.
  if (JSON.stringify(contextoIrrigacao(agora)) !== ultimoContexto) avaliarEAtuar(agora);

  // Marco 4: snapshot do estado das regras, so quando muda.
  salvarEstadoSeMudou(agora, false);
  // Marco 4: estado corrente para o app (retido), na mudanca ou no pulso.
  publicarEstadoVaso(agora, false);
}, 500);

// ---------------------------------------------------------------------------
// Marco 4 -- snapshot, restauracao e perfil de cuidado
// ---------------------------------------------------------------------------

let ultimoSnapshot = '';
let snapshotEm = 0;

function exportarEstado() {
  return {
    versao: 1,
    solo: estado.exportar(),
    ambiente: ambiente.exportar(),
    verificacao: verificacao.exportar(),
    adubacao: adubacao.exportar(),
    contadores: { cmd: contadorAtual(), atu: atuadores.contador }
  };
}

/*
 * Banco fora do ar na PARTIDA: o servico comecou do zero. Quando o banco
 * voltar, o snapshot antigo NAO pode ser sobrescrito pelo estado novo (que nao
 * sabe das doses de antes) -- primeiro ele e MESCLADO de forma conservadora:
 * uniao das doses, maior contador, bloqueios preservados.
 */
let mesclaPendente = false;
let mesclando = false;

async function mesclarEstadoTardio() {
  mesclando = true;
  try {
    const salvo = await persistencia.carregarEstado(CHAVE_ESTADO);
    const s = salvo && salvo.valor;
    const notas = [];
    if (s) {
      const agora = Date.now();
      const doses = new Set([...adubacao.doses, ...((s.adubacao && s.adubacao.doses) || [])]);
      adubacao.doses = [...doses].sort((a, b) => a - b);
      notas.push(`${adubacao.dosesNaJanela(agora)} dose(s) na janela`);
      if (s.verificacao && s.verificacao.bloqueadaDesde && verificacao.bloqueadaDesde === null) {
        verificacao.bloqueadaDesde = s.verificacao.bloqueadaDesde;
        verificacao.diagnostico = s.verificacao.diagnostico;
        notas.push(`bloqueio de irrigacao recuperado (${s.verificacao.diagnostico})`);
      }
      if (s.adubacao && s.adubacao.estado === 'BLOQUEADA' && adubacao.estado === 'OCIOSO') {
        adubacao.estado = 'BLOQUEADA';
        adubacao.desde = s.adubacao.desde;
        notas.push('bloqueio de adubacao recuperado');
      }
      restaurarContador(s.contadores && s.contadores.cmd);
      if (s.contadores && Number.isInteger(s.contadores.atu)) atuadores.contador = Math.max(atuadores.contador, s.contadores.atu);
      log.registrar('ESTADO', `banco voltou: estado salvo mesclado ao atual (${notas.join('; ')})`);
      gravarTransicao('servico', { anterior: 'SEM_BANCO', atual: 'ESTADO_MESCLADO', motivo: notas.join('; ') });
    }
    mesclaPendente = false;
  } catch (e) {
    // continua pendente: tenta de novo na proxima volta do tick
  } finally {
    mesclando = false;
  }
}

function salvarEstadoSeMudou(agora, forcar) {
  if (!persistencia.habilitada || !servicoPronto) return;
  if (mesclaPendente) {
    if (persistencia.conectado && !mesclando) mesclarEstadoTardio();
    return;
  }
  if (!forcar && agora - snapshotEm < cfg.persistencia.intervaloSnapshotMs) return;
  const snap = exportarEstado();
  const texto = JSON.stringify(snap);
  if (texto === ultimoSnapshot) return;
  ultimoSnapshot = texto;
  snapshotEm = agora;
  persistencia.salvarEstado(CHAVE_ESTADO, { ...snap, salvoEm: new Date(agora).toISOString() });
}

/*
 * Restaura o snapshot salvo. So acontece na PARTIDA: depois que o servico
 * comecou a decidir, o estado vivo e a verdade e um snapshot antigo nao o
 * sobrescreve (por isso, se o banco so voltar depois, nada e restaurado).
 */
async function restaurarEstado() {
  let salvo = null;
  try {
    salvo = await persistencia.carregarEstado(CHAVE_ESTADO);
  } catch (e) {
    log.registrar('PERSISTENCIA', `nao foi possivel ler o estado salvo (${e.message}): partindo do zero`);
    return;
  }
  if (!salvo) {
    log.registrar('PERSISTENCIA', 'nenhum estado salvo para este vaso: partindo do zero');
    return;
  }
  const agora = Date.now();
  const s = salvo.valor;
  const t = estado.restaurar(s.solo);
  ambiente.restaurar(s.ambiente);
  const notas = [
    `solo ${t.atual} (ultimo valor ${estado.ultimoValor ?? '-'}%, ${estado.ordemEventIds.length} eventIds para deduplicacao)`,
    ...verificacao.restaurar(s.verificacao),
    ...adubacao.restaurar(s.adubacao, agora)
  ];
  restaurarContador(s.contadores && s.contadores.cmd);
  if (s.contadores && Number.isInteger(s.contadores.atu)) atuadores.contador = Math.max(atuadores.contador, s.contadores.atu);
  const idade = Math.round((agora - new Date(salvo.atualizadoEm).getTime()) / 1000);
  log.registrar('ESTADO', `restaurado do banco (salvo ha ${idade}s): ${notas.join('; ')}`, { restaurado: s });
  gravarTransicao('servico', { anterior: 'REINICIADO', atual: 'ESTADO_RESTAURADO', motivo: notas.join('; ') });
}

let perfilEfetivo = null;
let perfilAssinatura = '';

/* Le o cadastro, resolve o perfil e aplica no cfg se algo mudou. */
async function recarregarPerfil(partida) {
  if (!persistencia.habilitada || !persistencia.conectado) return;
  let cad;
  try {
    cad = await persistencia.carregarCadastro(cfg.identidade.vasoId);
  } catch (e) {
    return; // banco caiu entre a checagem e a consulta: tenta na proxima volta
  }
  const assinatura = JSON.stringify(cad);
  if (assinatura === perfilAssinatura) return;
  perfilAssinatura = assinatura;

  if (!cad) {
    if (partida) log.registrar('PERFIL', `${cfg.identidade.vasoId} nao cadastrado (npm run banco:seed): usando config.json`);
  } else if (!cad.ativo) {
    log.registrar('PERFIL', `${cad.vaso_id} esta inativo no cadastro: perfil mantido`);
    return;
  }
  const r = perfil.resolverPerfil(PADRAO_PERFIL, perfil.camadasDoCadastro(cad), cfg.sobrescritasAmbiente);
  for (const i of r.ignoradas) log.registrar('PERFIL', `camada ${i.origem} ignorada: ${i.motivo}`);
  if (!r.ok) {
    log.registrar('PERFIL', `perfil incoerente, nada aplicado: ${r.erro}`);
    return;
  }
  const mudancas = perfil.aplicarPerfil(cfg, r.valores);
  perfilEfetivo = { vaso: cad && cad.vaso_id, especie: cad && cad.especie_id, grupo: cad && cad.grupo_id, valores: r.valores };
  if (cad) {
    log.registrar('PERFIL', `${cad.vaso_id} "${cad.nome}" especie=${cad.especie_id || '-'} grupo=${cad.grupo_id || '-'}` +
      (mudancas.length ? '' : ' (sem mudanca de parametros)'));
  }
  for (const m of mudancas) {
    log.registrar('PERFIL', `${m.chave}: ${m.de} -> ${m.para} (${m.origem})`, m);
  }
  if (mudancas.length) {
    gravarTransicao('perfil', {
      anterior: null,
      atual: cad ? `especie:${cad.especie_id || '-'} grupo:${cad.grupo_id || '-'}` : 'config.json',
      motivo: mudancas.map((m) => `${m.chave}=${m.para}`).join(', ')
    });
    // Um limiar novo pode mudar a decisao agora mesmo.
    if (servicoPronto) avaliarEAtuar(Date.now());
  }
}

setInterval(() => recarregarPerfil(false), cfg.persistencia.intervaloPerfilMs || 15000).unref();

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
        adubacao: adubacao.resumo(agora),
        luz: luz.resumo(agora),
        persistencia: persistencia.status(),
        perfil: perfilEfetivo
          ? { vaso: perfilEfetivo.vaso, especie: perfilEfetivo.especie, grupo: perfilEfetivo.grupo,
              limiarLiga: cfg.regra.limiarLiga, limiarDesliga: cfg.regra.limiarDesliga,
              umidadeArMin: cfg.ambiente.umidadeArMin, ec25MinUsCm: cfg.adubacao.ec25MinUsCm }
          : 'config.json'
      }, null, 2));
      console.log('');
    }
    // Marco 4: reconhecimento de falha -- o mesmo que o botao do aplicativo
    // (SolicitacaoApp RECONHECER_FALHA), pelo teclado do servico.
    if (k === 'r') reconhecerFalhas(Date.now(), 'teclado');
    if (k === String.fromCharCode(3)) encerrar();
  });
}

let encerrando = false;

async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  log.registrar('CONEXAO', 'encerrando servico');
  setTimeout(() => process.exit(0), 3000).unref();
  // Marco 4: ultimo snapshot e despejo da fila antes de sair.
  salvarEstadoSeMudou(Date.now(), true);
  await persistencia.fechar(1500);
  log.fechar();
  cliente.end(true, () => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

// ---------------------------------------------------------------------------
// Partida (Marco 4): banco -> estado salvo -> perfil -> broker
// ---------------------------------------------------------------------------

async function partida() {
  await persistencia.iniciar();
  if (persistencia.conectado) {
    await restaurarEstado();
    await recarregarPerfil(true);
  } else if (persistencia.habilitada) {
    mesclaPendente = true;
  }
  log.registrar('ESTADO',
    `regra efetiva: liga<${cfg.regra.limiarLiga}% desliga>${cfg.regra.limiarDesliga}% ` +
      `ar<${cfg.ambiente.umidadeArMin}% EC<${cfg.adubacao.ec25MinUsCm}uS/cm`);
  servicoPronto = true;
  cliente.connect();
}

partida().catch((e) => {
  // Nenhuma falha da persistencia impede o servico de funcionar em memoria.
  log.registrar('PERSISTENCIA', `falha na partida (${e.message}): seguindo em memoria`);
  servicoPronto = true;
  cliente.connect();
});

'use strict';
/*
 * gateway-vaso (simulador) -- COMPONENTE PRODUTOR do Marco 2, caminho A.
 *
 * DECLARACAO DE SUBSTITUTO
 * ------------------------
 * Este processo NAO e um dispositivo. Ele reproduz, em Node, exatamente o mesmo
 * contrato que o firmware ESP32 de produtor-esp32/sketch.ino publica -- mesmos
 * topicos, mesmos campos, mesma will message. Nao ha aquisicao fisica de
 * umidade de solo: o valor e controlado pelo teclado.
 *
 * Por que ele existe, alem do ESP32 real:
 *
 *   1. O ESP32 simulado no Wokwi nao alcanca o localhost desta maquina, logo o
 *      caminho com dispositivo real exige um broker publico e, portanto,
 *      internet. Este simulador fecha o fluxo inteiro offline.
 *   2. Provocar as condicoes de falha com precisao (duplicata exata, payload
 *      fora de contrato, queda abrupta sem DISCONNECT) e trivial aqui e
 *      trabalhoso no simulador de hardware.
 *
 * A pratica de declarar entradas substitutas em vez de disfarca-las de medicao
 * real vem dos relatorios do Marco 1 e e mantida aqui de proposito.
 *
 * TECLAS
 *   -  /  +   desce / sobe a umidade em 5 pontos
 *   s  /  m   seco (20%) / molhado (60%)
 *   d         republica o ULTIMO evento com o MESMO eventId  -> duplicata (F2)
 *   x         publica payload fora de contrato (valor 150%)  -> rejeicao (F4)
 *   v         publica com schemaVersion 2, desconhecida      -> rejeicao (F4)
 *   i         publica leitura com valid:false                -> leitura invalida
 *   p         pausa / retoma a telemetria (silencio)         -> expiracao (F1)
 *   k         mata a conexao SEM DISCONNECT                  -> dispara o LWT (F1)
 *   q         encerra limpo (DISCONNECT, sem LWT)
 *
 * MARCO 4 -- sensores e atuadores novos, com uma FISICA SIMPLES declarada:
 * bomba ligada sobe a umidade do solo e baixa o reservatorio de agua; dose de
 * adubo sobe a EC e baixa o reservatorio de adubo; umidificador sobe a umidade
 * do ar. Nada disso e medicao real -- e o minimo para fechar o laco e permitir
 * que o servico VERIFIQUE o efeito de cada atuacao.
 *   h  /  j   ar seco (35%) / ar umido (65%)                  -> R1 umidificador
 *   n  /  b   EC baixa (500) / EC alta (2500) uS/cm            -> R3 adubacao / excesso
 *   l         EC normal (1200 uS/cm)
 *   r  /  t   reservatorio de agua / de adubo no CRITICO (5%)  -> bloqueio da bomba
 *   w         reabastece os dois reservatorios (100%)
 *   f         liga/desliga "bomba sem fluxo" (atuador falha)   -> FALHA_IRRIGACAO / FALHA_ADUBACAO
 *   z         liga/desliga falha do DHT22 (valid:false)        -> SENSOR_FALHOU, umidificador desliga
 */

const crypto = require('crypto');
const contrato = require('../../contrato');
const seguranca = require('../../seguranca');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);

const DEVICE_ID = cfg.identidade.deviceIdSimulador;
const ENTITY_ID = cfg.identidade.vasoId;

/*
 * Chave HMAC deste dispositivo. Tudo o que ele publica sai assinado, e todo
 * comando que ele recebe precisa vir assinado pelo servico com esta mesma chave.
 */
const CHAVE = seguranca.dispositivo(DEVICE_ID).chave;

/* Publica um objeto assinado. O topico entra na assinatura. */
function publicarAssinado(topico, objeto, opcoes) {
  cliente.publish(topico, seguranca.assinar(CHAVE, topico, objeto), opcoes);
}

/*
 * bootId: identidade desta execucao.
 *
 * Sem NTP, eventTimeMs e sequence reiniciam a cada boot -- limitacao declarada
 * nos relatorios do Marco 1. O bootId e a identidade adicional que faltava:
 * com ele, eventId = deviceId:bootId:sequence e unico de verdade, e o consumidor
 * consegue perceber que o dispositivo reiniciou.
 */
const BOOT_ID = crypto.randomBytes(3).toString('hex');
const INICIO_MS = Date.now();

let sequencia = 0; // UNICO para solo, ar e nivel: o eventId nunca se repete entre eles
let umidade = cfg.simulador.umidadeInicial;
let pausado = false;
let ultimoEventoPublicado = null;
let ultimaLeituraEmMs = 0;

// Marco 4: grandezas simuladas (valores "verdadeiros" do mundo ficticio).
const mundo = {
  tempSolo: 24,
  ec25: 1200, // uS/cm a 25 C: o nutriente "verdadeiro"
  tempAr: 26,
  umidadeAr: 55,
  nivelAgua: 80, // %
  nivelAdubo: 80,
  semFluxo: false, // atuador com defeito: liga, mas nao move nada
  dhtFalha: false
};
const GEOMETRIA = { AGUA: { altura: 30, folga: 3 }, ADUBO: { altura: 15, folga: 3 } };
const NIVEL_CRITICO_LOCAL = 10; // protecao fisica local, independente do servico
const UMIDADE_MIN_ADUBAR = 35;
const DOSE_MAXIMA_MS = 10000;
const CONCESSAO_MAXIMA_MS = 120000;

/* millis() do dispositivo: tempo desde o inicio desta execucao. */
function millis() {
  return Date.now() - INICIO_MS;
}

// ---------------------------------------------------------------------------
// Conexao, com will message
// ---------------------------------------------------------------------------

/*
 * A will message e registrada no CONNECT, antes de qualquer publicacao. E o
 * broker que a publica, e somente se a conexao terminar sem DISCONNECT. E esse
 * o mecanismo que torna a morte do dispositivo observavel de imediato, sem
 * esperar que a validade do dado expire por tempo.
 */
/*
 * A will message tambem e assinada: e o dispositivo que a escreve, no CONNECT,
 * e o broker so a repassa. Sem isso, qualquer um poderia publicar um OFFLINE
 * falso e revogar a irrigacao de um vaso alheio.
 */
const will = {
  topic: topicos.heartbeat,
  payload: seguranca.assinar(CHAVE, topicos.heartbeat, {
    schemaVersion: 1,
    eventType: 'EstadoConectividade',
    deviceId: DEVICE_ID,
    entityId: ENTITY_ID,
    bootId: BOOT_ID,
    state: 'OFFLINE',
    reason: 'lwt_conexao_encerrada_sem_disconnect'
  }),
  qos: cfg.mqtt.qos,
  retain: true
};

/*
 * Identidade = deviceId. No broker local, TLS + usuario/senha, e a ACL so deixa
 * este gateway publicar nos topicos do PROPRIO vaso.
 */
const cliente = contrato.conectar(cfg, DEVICE_ID, {
  clientId: `${DEVICE_ID}-${BOOT_ID}`,
  clean: true,
  will
});

console.log('');
console.log('gateway-vaso (SIMULADOR -- substituto declarado do ESP32)');
console.log(`  broker      ${cfg.mqtt.url}`);
console.log(`  deviceId    ${DEVICE_ID}`);
console.log(`  bootId      ${BOOT_ID}`);
console.log(`  publica     ${topicos.telemetriaSolo}`);
console.log(`              ${topicos.telemetriaAmbiente}`);
console.log(`              ${topicos.telemetriaReservatorio}`);
console.log(`              ${topicos.heartbeat}  (retained + LWT)`);
console.log(`  assina      ${topicos.comandoIrrigacao}`);
console.log(`              ${topicos.comandoAtuador}`);
console.log('');
console.log(`  seguranca   ${contrato.brokerLocal(cfg.mqtt.url) ? 'TLS + usuario/senha + ACL' : 'TLS (broker publico, sem senha)'} + HMAC`);
console.log('');
console.log('  teclas: -/+ umidade  s seco  m molhado  d duplicar  x fora-contrato');
console.log('          v versao-2  i invalida  p pausar  k matar(LWT)  q sair');
console.log('  ataques: a sem-assinatura  g adulterada  o deviceId-alheio  c vaso-alheio');
console.log('  marco 4: h/j ar seco/umido  n/b/l EC baixa/alta/normal  r/t agua/adubo critico');
console.log('           w reabastecer  f bomba sem fluxo  z falha do DHT22');
console.log('');

cliente.on('connect', () => {
  console.log(`[${millis()}ms] CONECTADO -- will message registrada no broker`);
  cliente.subscribe([topicos.comandoIrrigacao, topicos.comandoAtuador], { qos: cfg.mqtt.qos });
});

cliente.on('reconnect', () => console.log(`[${millis()}ms] reconectando...`));
cliente.on('error', (e) => console.log(`[${millis()}ms] erro: ${e.message}`));

// ---------------------------------------------------------------------------
// Publicacao de telemetria
// ---------------------------------------------------------------------------

function montarLeitura(opcoes) {
  const o = opcoes || {};
  sequencia += 1;
  const evento = {
    schemaVersion: o.schemaVersion !== undefined ? o.schemaVersion : 1,
    eventId: `${DEVICE_ID}:${BOOT_ID}:${String(sequencia).padStart(6, '0')}`,
    eventType: 'LeituraUmidadeSolo',
    deviceId: DEVICE_ID,
    entityId: ENTITY_ID,
    bootId: BOOT_ID,
    eventTimeMs: millis(),
    sequence: sequencia,
    value: o.value !== undefined ? o.value : Number(umidade.toFixed(1)),
    unit: 'pct_simulado',
    valid: o.valid !== undefined ? o.valid : true
  };
  if (evento.valid === false) {
    evento.invalidReason = 'sensor_possivelmente_desconectado';
    return evento;
  }
  // Marco 4: sonda 3-em-1 -- temperatura do solo e EC, com o mesmo modelo do
  // custom chip do Wokwi: a EC aparente cai com o solo seco e sobe ~2%/C.
  const u = evento.value;
  const fatorUmidade = Math.min(Math.max(u / 60, 0), 1.5);
  const fatorTemp = 1 + 0.02 * (mundo.tempSolo - 25);
  const ecAparente = mundo.ec25 * fatorUmidade * fatorTemp;
  evento.soilTempC = mundo.tempSolo;
  evento.ecApparentUsCm = Math.round(Math.min(ecAparente, 5000));
  evento.ecValid = u >= 35 && u <= 75;
  if (evento.ecValid) evento.ec25UsCm = Math.round(ecAparente / fatorTemp / fatorUmidade);
  else evento.ecInvalidReason = 'umidade_fora_faixa_ec';
  return evento;
}

function cabecalho(eventType) {
  sequencia += 1;
  return {
    schemaVersion: 1,
    eventId: `${DEVICE_ID}:${BOOT_ID}:${String(sequencia).padStart(6, '0')}`,
    eventType,
    deviceId: DEVICE_ID,
    entityId: ENTITY_ID,
    bootId: BOOT_ID,
    eventTimeMs: millis(),
    sequence: sequencia
  };
}

function publicarAmbiente() {
  const ev = cabecalho('LeituraAmbiente');
  if (mundo.dhtFalha) {
    ev.valid = false;
    ev.invalidReason = 'dht22_sem_resposta';
  } else {
    ev.temperatureC = mundo.tempAr;
    ev.humidityPct = Number(mundo.umidadeAr.toFixed(1));
    ev.valid = true;
  }
  publicarAssinado(topicos.telemetriaAmbiente, ev, { qos: cfg.mqtt.qos });
}

function publicarNivel(reservatorio) {
  const g = GEOMETRIA[reservatorio];
  const nivel = reservatorio === 'AGUA' ? mundo.nivelAgua : mundo.nivelAdubo;
  const ev = cabecalho('NivelReservatorio');
  ev.reservoir = reservatorio;
  ev.distanceCm = Number((g.folga + g.altura * (1 - nivel / 100)).toFixed(1));
  ev.levelPct = Number(nivel.toFixed(1));
  ev.valid = true;
  publicarAssinado(topicos.telemetriaReservatorio, ev, { qos: cfg.mqtt.qos });
}

function publicarLeitura(evento, etiqueta) {
  publicarAssinado(topicos.telemetriaSolo, evento, { qos: cfg.mqtt.qos });
  ultimaLeituraEmMs = millis();
  console.log(
    `[${evento.eventTimeMs}ms] -> telemetria ${evento.eventId} valor=${evento.value}%` +
      (etiqueta ? `  ${etiqueta}` : '')
  );
}

setInterval(() => {
  if (pausado || !cliente.connected) return;
  const evento = montarLeitura();
  ultimoEventoPublicado = evento;
  publicarLeitura(evento);
}, cfg.simulador.intervaloTelemetriaMs);

// Marco 4: telemetria de ar e de nivel (pausada junto com a de solo).
setInterval(() => {
  if (pausado || !cliente.connected) return;
  publicarAmbiente();
}, cfg.simulador.intervaloAmbienteMs || 2000);

setInterval(() => {
  if (pausado || !cliente.connected) return;
  publicarNivel('AGUA');
  publicarNivel('ADUBO');
}, cfg.simulador.intervaloNivelMs || 1500);

/*
 * Fisica simples + protecoes LOCAIS que nao dependem do servico: a bomba para
 * se o reservatorio chega ao critico no meio do pulso, e o umidificador desliga
 * se o DHT22 falha. Quem sofre a consequencia fisica e o dispositivo.
 */
setInterval(() => {
  if (bombaLigada) {
    if (!mundo.semFluxo) {
      umidade = Math.min(100, umidade + 2.5);
      mundo.nivelAgua = Math.max(0, mundo.nivelAgua - 0.8);
    }
    if (mundo.nivelAgua <= NIVEL_CRITICO_LOCAL) desligarBomba('reservatorio de agua chegou ao critico');
  }
  if (aduboLigado) {
    if (!mundo.semFluxo) {
      mundo.ec25 += 80;
      mundo.nivelAdubo = Math.max(0, mundo.nivelAdubo - 1.5);
    }
    if (mundo.nivelAdubo <= NIVEL_CRITICO_LOCAL) desligarAdubo('reservatorio de adubo chegou ao critico');
  }
  if (umidificadorLigado) {
    mundo.umidadeAr = Math.min(95, mundo.umidadeAr + 1.5);
    if (mundo.dhtFalha) desligarUmidificador('DHT22 em falha');
  } else {
    mundo.umidadeAr += (45 - mundo.umidadeAr) * 0.01; // volta devagar ao ar da casa
  }
}, 500);

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/*
 * O heartbeat e publicado SEMPRE, inclusive quando a telemetria esta pausada --
 * a ausencia de dado e, ela mesma, uma informacao a reportar. E o mecanismo do
 * recorte de comunicacao e resiliencia do Marco 1, agora atravessando a rede.
 * retain: true garante que um assinante que chegue depois conheca o estado
 * corrente sem esperar o proximo ciclo.
 */
let seqHeartbeat = 0;

setInterval(() => {
  if (!cliente.connected) return;
  seqHeartbeat += 1;
  const silencio = millis() - ultimaLeituraEmMs;
  const hb = {
    schemaVersion: 1,
    eventType: 'EstadoConectividade',
    deviceId: DEVICE_ID,
    entityId: ENTITY_ID,
    bootId: BOOT_ID,
    eventTimeMs: millis(),
    sequence: seqHeartbeat,
    value: silencio,
    unit: 'ms_desde_ultimo_evento',
    state: silencio > cfg.regra.validadeMs ? 'SILENCIOSO' : 'ATIVO'
  };
  publicarAssinado(topicos.heartbeat, hb, {
    qos: cfg.mqtt.qos,
    retain: true
  });
}, cfg.simulador.intervaloHeartbeatMs);

// ---------------------------------------------------------------------------
// Recepcao de comando: idempotencia + expiracao, iguais as do firmware
// ---------------------------------------------------------------------------

const chavesAplicadas = new Set();
let bombaLigada = false;
let timerPulso = null;
let aduboLigado = false;
let timerAdubo = null;
let umidificadorLigado = false;
let timerConcessao = null;

function desligarBomba(motivo) {
  if (!bombaLigada) return;
  bombaLigada = false;
  clearTimeout(timerPulso);
  console.log(`[${millis()}ms]    BOMBA DESLIGADA (${motivo})`);
}

function desligarAdubo(motivo) {
  if (!aduboLigado) return;
  aduboLigado = false;
  clearTimeout(timerAdubo);
  console.log(`[${millis()}ms]    BOMBA DE ADUBO DESLIGADA (${motivo})`);
}

function desligarUmidificador(motivo) {
  if (!umidificadorLigado) return;
  umidificadorLigado = false;
  clearTimeout(timerConcessao);
  console.log(`[${millis()}ms]    UMIDIFICADOR DESLIGADO (${motivo})`);
}

/*
 * Protecoes fisicas locais (Marco 4). O comando e autentico e esta no prazo,
 * mas executa-lo seria perigoso: REJEITADO_SEGURANCA, com o motivo no detail.
 */
function motivoInseguro(alvo, acao) {
  if (alvo === 'BOMBA_AGUA' && acao === 'PULSO_IRRIGACAO') {
    if (mundo.nivelAgua <= NIVEL_CRITICO_LOCAL) return 'reservatorio_agua_critico';
    if (aduboLigado) return 'intertravamento_bomba_adubo';
  }
  if (alvo === 'BOMBA_ADUBO' && acao === 'PULSO') {
    if (mundo.nivelAdubo <= NIVEL_CRITICO_LOCAL) return 'reservatorio_adubo_critico';
    if (bombaLigada) return 'intertravamento_bomba_agua';
    if (umidade < UMIDADE_MIN_ADUBAR) return 'solo_seco_nao_adubar';
  }
  if (alvo === 'UMIDIFICADOR' && acao === 'LIGAR' && mundo.dhtFalha) return 'sensor_ar_invalido';
  return null;
}

/*
 * Etapas comuns a qualquer comando: assinatura, contrato, idempotencia e prazo.
 * Devolve o comando se pode seguir; senao ja respondeu e devolve null.
 */
function admitirComando(topico, buffer, tipo, topicoAck) {
  const sig = seguranca.verificarAssinatura(CHAVE, topico, buffer.toString('utf8'));
  if (!sig.ok) {
    const talvez = contrato.desserializar(buffer);
    console.log(`[${millis()}ms] <- comando RECUSADO (${sig.motivo}) -- nao foi o servico que assinou`);
    responder(talvez.ok ? talvez.payload : null, 'REJEITADO_ASSINATURA', sig.motivo, topicoAck);
    return null;
  }
  const bruto = contrato.desserializar(buffer);
  if (!bruto.ok) { responder(null, 'REJEITADO_CONTRATO', bruto.motivo, topicoAck); return null; }
  const cmd = bruto.payload;
  const valido = contrato.validar(tipo, cmd);
  if (!valido.ok) { responder(cmd, 'REJEITADO_CONTRATO', valido.motivo, topicoAck); return null; }
  if (chavesAplicadas.has(cmd.idempotencyKey)) {
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} DUPLICADO -- efeito nao repetido`);
    responder(cmd, 'IGNORADO_DUPLICADO', 'idempotencyKey ja aplicada', topicoAck);
    return null;
  }
  if (millis() >= cmd.expiresAtDeviceMs) {
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} EXPIRADO -- nao atua tarde`);
    responder(cmd, 'REJEITADO_EXPIRADO', `millis=${millis()} >= ${cmd.expiresAtDeviceMs}`, topicoAck);
    return null;
  }
  return cmd;
}

function tratarComandoAtuador(topico, buffer) {
  const cmd = admitirComando(topico, buffer, 'ComandoAtuador', topicos.ackAtuador);
  if (!cmd) return;
  const inseguro = motivoInseguro(cmd.actuator, cmd.action);
  if (inseguro) {
    // A chave NAO e registrada: o mesmo comando, se reenviado depois que a
    // condicao mudar, ainda e avaliado de novo -- e recusado de novo se preciso.
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} ${cmd.actuator} ${cmd.action} RECUSADO por seguranca (${inseguro})`);
    return responder(cmd, 'REJEITADO_SEGURANCA', inseguro, topicos.ackAtuador);
  }
  chavesAplicadas.add(cmd.idempotencyKey);

  if (cmd.actuator === 'UMIDIFICADOR') {
    if (cmd.action === 'LIGAR') {
      const prazo = Math.min(cmd.durationMs, CONCESSAO_MAXIMA_MS);
      umidificadorLigado = true;
      clearTimeout(timerConcessao);
      timerConcessao = setTimeout(() => desligarUmidificador('concessao vencida sem renovacao'), prazo);
      console.log(`[${millis()}ms] <- comando ${cmd.commandId} UMIDIFICADOR LIGADO (concessao ${prazo}ms)`);
    } else {
      desligarUmidificador(`comando ${cmd.commandId}`);
    }
  } else if (cmd.action === 'PULSO') {
    const dose = Math.min(cmd.durationMs, DOSE_MAXIMA_MS);
    aduboLigado = true;
    clearTimeout(timerAdubo);
    timerAdubo = setTimeout(() => desligarAdubo('dose concluida'), dose);
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} BOMBA DE ADUBO LIGADA (dose ${dose}ms)`);
  } else {
    desligarAdubo(`comando ${cmd.commandId}`);
  }
  responder(cmd, 'EXECUTADO', `${cmd.actuator}_${cmd.action}`, topicos.ackAtuador);
}

cliente.on('message', (topico, buffer) => {
  if (topico === topicos.comandoAtuador) return tratarComandoAtuador(topico, buffer);
  if (topico !== topicos.comandoIrrigacao) return;

  /*
   * Autenticidade ANTES de tudo. Quem sofre a consequencia fisica e o
   * dispositivo, entao a ultima barreira tem de estar aqui: mesmo que o broker
   * deixe passar (broker publico, credencial vazada), comando que nao foi
   * assinado pelo servico com a chave deste dispositivo nao liga a bomba.
   */
  const sig = seguranca.verificarAssinatura(CHAVE, topico, buffer.toString('utf8'));
  if (!sig.ok) {
    const talvez = contrato.desserializar(buffer);
    console.log(`[${millis()}ms] <- comando RECUSADO (${sig.motivo}) -- nao foi o servico que assinou`);
    return responder(talvez.ok ? talvez.payload : null, 'REJEITADO_ASSINATURA', sig.motivo);
  }

  const bruto = contrato.desserializar(buffer);
  if (!bruto.ok) return responder(null, 'REJEITADO_CONTRATO', bruto.motivo);

  const cmd = bruto.payload;
  const valido = contrato.validar('ComandoIrrigacao', cmd);
  if (!valido.ok) return responder(cmd, 'REJEITADO_CONTRATO', valido.motivo);

  // Idempotencia: a mesma chave nunca produz o efeito duas vezes.
  if (chavesAplicadas.has(cmd.idempotencyKey)) {
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} DUPLICADO -- efeito nao repetido`);
    return responder(cmd, 'IGNORADO_DUPLICADO', 'idempotencyKey ja aplicada');
  }

  // Expiracao, no relogio do proprio dispositivo.
  if (millis() >= cmd.expiresAtDeviceMs) {
    console.log(
      `[${millis()}ms] <- comando ${cmd.commandId} EXPIRADO ` +
        `(prazo era ${cmd.expiresAtDeviceMs}ms) -- nao atua tarde`
    );
    return responder(cmd, 'REJEITADO_EXPIRADO', `millis=${millis()} >= ${cmd.expiresAtDeviceMs}`);
  }

  // Marco 4: protecao fisica local antes de executar.
  const inseguro = motivoInseguro('BOMBA_AGUA', cmd.action);
  if (inseguro) {
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} RECUSADO por seguranca (${inseguro})`);
    return responder(cmd, 'REJEITADO_SEGURANCA', inseguro);
  }

  chavesAplicadas.add(cmd.idempotencyKey);

  if (cmd.action === 'PULSO_IRRIGACAO') {
    bombaLigada = true;
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} BOMBA LIGADA (pulso ${cmd.durationMs}ms)`);
    clearTimeout(timerPulso);
    timerPulso = setTimeout(() => {
      bombaLigada = false;
      console.log(`[${millis()}ms]    pulso encerrado, BOMBA DESLIGADA`);
    }, cmd.durationMs);
  } else {
    bombaLigada = false;
    clearTimeout(timerPulso);
    console.log(`[${millis()}ms] <- comando ${cmd.commandId} BOMBA DESLIGADA`);
  }

  responder(cmd, 'EXECUTADO', cmd.action);
});

function responder(cmd, resultado, detalhe, topicoAck) {
  const ack = {
    schemaVersion: 1,
    eventType: 'ConfirmacaoAtuacao',
    deviceId: DEVICE_ID,
    bootId: BOOT_ID,
    commandId: cmd ? cmd.commandId : 'desconhecido',
    correlationId: cmd ? cmd.correlationId : 'desconhecido',
    result: resultado,
    appliedAtDeviceMs: millis(),
    detail: detalhe || ''
  };
  publicarAssinado(topicoAck || topicos.ackIrrigacao, ack, { qos: cfg.mqtt.qos });
}

// ---------------------------------------------------------------------------
// Console de demonstracao
// ---------------------------------------------------------------------------

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', tratarTecla);
} else if (process.env.SIMULADOR_TECLAS_STDIN === '1') {
  // Marco 4: o teste de integracao "aperta as teclas" por um pipe, uma por
  // caractere -- os mesmos cenarios da demonstracao, de forma repetivel.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (texto) => { for (const tecla of texto) tratarTecla(tecla); });
}

function tratarTecla(tecla) {
  switch (tecla) {
    case '-':
    case '_':
      umidade = Math.max(0, umidade - 5);
      console.log(`   umidade -> ${umidade}%`);
      break;

    case '+':
    case '=':
      umidade = Math.min(100, umidade + 5);
      console.log(`   umidade -> ${umidade}%`);
      break;

    case 's':
      umidade = 20;
      console.log('   umidade -> 20% (seco)');
      break;

    case 'm':
      umidade = 60;
      console.log('   umidade -> 60% (molhado)');
      break;

    /* F2 -- retry: republica o MESMO evento, com o MESMO eventId. */
    case 'd':
      if (!ultimoEventoPublicado) {
        console.log('   nada publicado ainda');
        break;
      }
      publicarLeitura(ultimoEventoPublicado, '[DUPLICATA: mesmo eventId]');
      break;

    /* F4 -- fora de contrato: valor acima da faixa valida. */
    case 'x':
      publicarLeitura(montarLeitura({ value: 150 }), '[FORA DE CONTRATO: 150%]');
      break;

    /* F4 -- versao desconhecida. */
    case 'v':
      publicarLeitura(montarLeitura({ schemaVersion: 2 }), '[schemaVersion 2 DESCONHECIDA]');
      break;

    /* Leitura que a validacao local do dispositivo recusou. */
    case 'i':
      publicarLeitura(montarLeitura({ valid: false }), '[valid:false]');
      break;

    /* S1 -- leitura SEM assinatura: o servico rejeita (ASSINATURA_AUSENTE). */
    case 'a': {
      const ev = montarLeitura({ value: 20 });
      cliente.publish(topicos.telemetriaSolo, JSON.stringify(ev), { qos: cfg.mqtt.qos });
      console.log(`[${ev.eventTimeMs}ms] -> telemetria ${ev.eventId} valor=20%  [ATAQUE: sem assinatura]`);
      break;
    }

    /*
     * S2 -- adulteracao no caminho: assina 60% e troca para 20% depois. E o que
     * um intermediario faria para provocar irrigacao. O HMAC deixa de conferir.
     */
    case 'g': {
      const ev = montarLeitura({ value: 60 });
      const texto = seguranca.assinar(CHAVE, topicos.telemetriaSolo, ev).replace('"value":60', '"value":20');
      cliente.publish(topicos.telemetriaSolo, texto, { qos: cfg.mqtt.qos });
      console.log(`[${ev.eventTimeMs}ms] -> telemetria ${ev.eventId} 60% trocado por 20% apos assinar  [ATAQUE: adulterada]`);
      break;
    }

    /*
     * S3 -- falsidade de origem: este gateway, autenticado como DEVICE_ID, publica
     * dizendo ser outro dispositivo. No broker local a ACL barra e DERRUBA a
     * conexao (o simulador reconecta sozinho em seguida).
     */
    case 'o': {
      const ev = { ...montarLeitura({ value: 20 }), deviceId: 'esp32-vaso-01' };
      publicarAssinado(topicos.telemetriaSolo, ev, { qos: cfg.mqtt.qos });
      console.log('   -> telemetria com deviceId=esp32-vaso-01  [ATAQUE: identidade alheia]');
      break;
    }

    /* S4 -- topico de outro vaso: a ACL amarra o gateway ao proprio vaso. */
    case 'c': {
      const alheio = topicos.telemetriaSolo.replace(`/vaso/${ENTITY_ID}/`, '/vaso/vaso-02/');
      publicarAssinado(alheio, montarLeitura({ value: 20 }), { qos: cfg.mqtt.qos });
      console.log(`   -> telemetria em ${alheio}  [ATAQUE: vaso alheio]`);
      break;
    }

    /* F1 -- silencio: para de publicar telemetria, heartbeat continua. */
    case 'p':
      pausado = !pausado;
      console.log(`   telemetria ${pausado ? 'PAUSADA (silencio)' : 'RETOMADA'}`);
      break;

    /*
     * F1 -- queda abrupta. Encerra o socket TCP sem enviar DISCONNECT, que e o
     * que faz o broker publicar a will message. Encerrar com 'q' NAO dispara o
     * LWT: e justamente esse contraste que a falha F1 demonstra.
     */
    case 'k':
      console.log('   MATANDO a conexao sem DISCONNECT -- o broker deve publicar o LWT');
      cliente.stream.destroy();
      setTimeout(() => process.exit(0), 300);
      break;

    // ----- Marco 4 -----
    case 'h':
      mundo.umidadeAr = 35;
      console.log('   umidade do ar -> 35% (seco)');
      break;
    case 'j':
      mundo.umidadeAr = 65;
      console.log('   umidade do ar -> 65% (umido)');
      break;
    case 'n':
      mundo.ec25 = 500;
      console.log('   EC25 -> 500 uS/cm (faltam nutrientes)');
      break;
    case 'b':
      mundo.ec25 = 2500;
      console.log('   EC25 -> 2500 uS/cm (excesso de nutrientes)');
      break;
    case 'l':
      mundo.ec25 = 1200;
      console.log('   EC25 -> 1200 uS/cm (normal)');
      break;
    case 'r':
      mundo.nivelAgua = 5;
      console.log('   reservatorio de AGUA -> 5% (critico)');
      break;
    case 't':
      mundo.nivelAdubo = 5;
      console.log('   reservatorio de ADUBO -> 5% (critico)');
      break;
    case 'w':
      mundo.nivelAgua = 100;
      mundo.nivelAdubo = 100;
      console.log('   reservatorios reabastecidos (100%)');
      break;
    case 'f':
      mundo.semFluxo = !mundo.semFluxo;
      console.log(`   bombas ${mundo.semFluxo ? 'SEM FLUXO (ligam, mas nao movem nada)' : 'normais'}`);
      break;
    case 'z':
      mundo.dhtFalha = !mundo.dhtFalha;
      console.log(`   DHT22 ${mundo.dhtFalha ? 'EM FALHA (valid:false)' : 'normal'}`);
      break;

    case 'q':
    case String.fromCharCode(3):
      console.log('   encerrando LIMPO (DISCONNECT -- o LWT nao sera publicado)');
      cliente.end(false, () => process.exit(0));
      setTimeout(() => process.exit(0), 1000);
      break;

    default:
      break;
  }
}

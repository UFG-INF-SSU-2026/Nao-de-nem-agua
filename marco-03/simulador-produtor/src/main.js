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
 */

const mqtt = require('mqtt');
const crypto = require('crypto');
const contrato = require('../../contrato');

const cfg = contrato.carregarConfig();
const topicos = contrato.topicos(cfg);

const DEVICE_ID = cfg.identidade.deviceIdSimulador;
const ENTITY_ID = cfg.identidade.vasoId;

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

let sequencia = 0;
let umidade = cfg.simulador.umidadeInicial;
let pausado = false;
let ultimoEventoPublicado = null;
let ultimaLeituraEmMs = 0;

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
const will = {
  topic: topicos.heartbeat,
  payload: JSON.stringify({
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

const cliente = mqtt.connect(cfg.mqtt.url, {
  clientId: `${DEVICE_ID}-${BOOT_ID}`,
  clean: true,
  reconnectPeriod: 2000,
  connectTimeout: 8000,
  will
});

console.log('');
console.log('gateway-vaso (SIMULADOR -- substituto declarado do ESP32)');
console.log(`  broker      ${cfg.mqtt.url}`);
console.log(`  deviceId    ${DEVICE_ID}`);
console.log(`  bootId      ${BOOT_ID}`);
console.log(`  publica     ${topicos.telemetriaSolo}`);
console.log(`              ${topicos.heartbeat}  (retained + LWT)`);
console.log(`  assina      ${topicos.comandoIrrigacao}`);
console.log('');
console.log('  teclas: -/+ umidade  s seco  m molhado  d duplicar  x fora-contrato');
console.log('          v versao-2  i invalida  p pausar  k matar(LWT)  q sair');
console.log('');

cliente.on('connect', () => {
  console.log(`[${millis()}ms] CONECTADO -- will message registrada no broker`);
  cliente.subscribe(topicos.comandoIrrigacao, { qos: cfg.mqtt.qos });
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
  if (evento.valid === false) evento.invalidReason = 'sensor_possivelmente_desconectado';
  return evento;
}

function publicarLeitura(evento, etiqueta) {
  cliente.publish(topicos.telemetriaSolo, JSON.stringify(evento), { qos: cfg.mqtt.qos });
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
  cliente.publish(topicos.heartbeat, JSON.stringify(hb), {
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

cliente.on('message', (topico, buffer) => {
  if (topico !== topicos.comandoIrrigacao) return;

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

function responder(cmd, resultado, detalhe) {
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
  cliente.publish(topicos.ackIrrigacao, JSON.stringify(ack), { qos: cfg.mqtt.qos });
}

// ---------------------------------------------------------------------------
// Console de demonstracao
// ---------------------------------------------------------------------------

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', tratarTecla);
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

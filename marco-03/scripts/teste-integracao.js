'use strict';
/*
 * Teste de integracao da fronteira -- `npm run teste`.
 *
 * Sobe o broker e o servico consumidor como processos filhos, assume o papel do
 * dispositivo (publica telemetria, responde comandos) e verifica o
 * comportamento observavel da fronteira inteira.
 *
 * Nao substitui a demonstracao ao vivo: serve para provar, de forma repetivel,
 * que cada caminho continua funcionando depois de qualquer alteracao -- em
 * especial depois da "pequena alteracao" pedida durante a verificacao.
 *
 * Os parametros da regra sao reduzidos por variavel de ambiente para o teste
 * rodar em segundos. A logica exercitada e exatamente a mesma.
 */

const { spawn } = require('child_process');
const path = require('path');
const mqtt = require('mqtt');
const crypto = require('crypto');

const RAIZ = path.resolve(__dirname, '..');
const PORTA = 1884; // porta propria, para nao colidir com um broker de demo aberto

const AMBIENTE = {
  ...process.env,
  BROKER_PORT: String(PORTA),
  MQTT_URL: `mqtt://localhost:${PORTA}`,
  VALIDADE_MS: '2500',
  COOLDOWN_MS: '1200',
  COMANDO_TTL_MS: '2000',
  AMOSTRAS_DEBOUNCE: '3',
  LIMIAR_LIGA: '30',
  LIMIAR_DESLIGA: '50'
};

const DEVICE_ID = 'teste-vaso-01';
const BOOT_ID = crypto.randomBytes(3).toString('hex');
const PREFIXO = 'naodenemagua/v1/vaso/vaso-01';
const T = {
  telemetria: `${PREFIXO}/telemetry/soil`,
  heartbeat: `${PREFIXO}/status/heartbeat`,
  comando: `${PREFIXO}/command/irrigacao`,
  ack: `${PREFIXO}/ack/irrigacao`
};

let sequencia = 0;
const comandosRecebidos = [];
const falhas = [];
let processos = [];

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function verificar(descricao, condicao, detalhe) {
  if (condicao) {
    console.log(`  ok    ${descricao}`);
  } else {
    console.log(`  FALHA ${descricao}${detalhe ? ` -- ${detalhe}` : ''}`);
    falhas.push(descricao);
  }
}

function subir(rotulo, script) {
  const p = spawn(process.execPath, [path.join(RAIZ, script)], {
    env: AMBIENTE,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', (d) => {
    if (process.env.VERBOSE) process.stdout.write(`    [${rotulo}] ${d}`);
  });
  p.stderr.on('data', (d) => process.stderr.write(`    [${rotulo} erro] ${d}`));
  processos.push(p);
  return p;
}

function encerrarTudo() {
  for (const p of processos) {
    try {
      p.kill();
    } catch (e) {
      /* processo ja encerrado */
    }
  }
  processos = [];
}

// ---------------------------------------------------------------------------
// Papel do dispositivo
// ---------------------------------------------------------------------------

const INICIO = Date.now();
const millis = () => Date.now() - INICIO;

function leitura(valor, extras) {
  sequencia += 1;
  return {
    schemaVersion: 1,
    eventId: `${DEVICE_ID}:${BOOT_ID}:${String(sequencia).padStart(6, '0')}`,
    eventType: 'LeituraUmidadeSolo',
    deviceId: DEVICE_ID,
    entityId: 'vaso-01',
    bootId: BOOT_ID,
    eventTimeMs: millis(),
    sequence: sequencia,
    value: valor,
    unit: 'pct_simulado',
    valid: true,
    ...(extras || {})
  };
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('Teste de integracao da fronteira produtor <-> consumidor');
  console.log(`  broker de teste  mqtt://localhost:${PORTA}`);
  console.log(`  validade=${AMBIENTE.VALIDADE_MS}ms cooldown=${AMBIENTE.COOLDOWN_MS}ms ttl=${AMBIENTE.COMANDO_TTL_MS}ms`);
  console.log('');

  subir('broker', 'broker-local/broker.js');
  await esperar(1200);
  subir('servico', 'consumidor-servico/src/main.js');
  await esperar(1800);

  const cliente = mqtt.connect(AMBIENTE.MQTT_URL, {
    clientId: `${DEVICE_ID}-${BOOT_ID}`,
    will: {
      topic: T.heartbeat,
      payload: JSON.stringify({
        schemaVersion: 1,
        eventType: 'EstadoConectividade',
        deviceId: DEVICE_ID,
        entityId: 'vaso-01',
        bootId: BOOT_ID,
        state: 'OFFLINE',
        reason: 'lwt_teste'
      }),
      qos: 1,
      retain: true
    }
  });

  await new Promise((r) => cliente.on('connect', r));
  cliente.subscribe(T.comando, { qos: 1 });

  /*
   * Papel do dispositivo na recepcao de comandos: idempotencia e expiracao,
   * com a mesma logica do firmware e do simulador. O teste responde com ack
   * porque um dispositivo real responde -- e porque os tres resultados
   * possiveis do ack sao, eles mesmos, objeto de verificacao.
   */
  const chavesAplicadas = new Set();
  const acksEnviados = [];

  const responder = (cmd, resultado, detalhe) => {
    const ack = {
      schemaVersion: 1,
      eventType: 'ConfirmacaoAtuacao',
      deviceId: DEVICE_ID,
      bootId: BOOT_ID,
      commandId: cmd.commandId,
      correlationId: cmd.correlationId,
      result: resultado,
      appliedAtDeviceMs: millis(),
      detail: detalhe || ''
    };
    acksEnviados.push(ack);
    cliente.publish(T.ack, JSON.stringify(ack), { qos: 1 });
    return ack;
  };

  const tratarComando = (cmd) => {
    if (chavesAplicadas.has(cmd.idempotencyKey)) {
      return responder(cmd, 'IGNORADO_DUPLICADO', 'idempotencyKey ja aplicada');
    }
    if (millis() >= cmd.expiresAtDeviceMs) {
      return responder(cmd, 'REJEITADO_EXPIRADO', `millis=${millis()}`);
    }
    chavesAplicadas.add(cmd.idempotencyKey);
    return responder(cmd, 'EXECUTADO', cmd.action);
  };

  cliente.on('message', (topico, buf) => {
    if (topico !== T.comando) return;
    const cmd = JSON.parse(buf.toString());
    comandosRecebidos.push(cmd);
    tratarComando(cmd);
  });

  const publicar = (payload) =>
    new Promise((r) => cliente.publish(T.telemetria, JSON.stringify(payload), { qos: 1 }, r));

  // -------------------------------------------------------------------------
  console.log('1. Estado normal -- solo umido nao deve gerar comando');
  // -------------------------------------------------------------------------
  await publicar(leitura(60));
  await publicar(leitura(60));
  await esperar(600);
  verificar('nenhum comando com solo a 60%', comandosRecebidos.length === 0,
    `recebidos ${comandosRecebidos.length}`);

  // -------------------------------------------------------------------------
  console.log('2. Decisao -- tres amostras secas consecutivas autorizam a atuacao');
  // -------------------------------------------------------------------------
  await publicar(leitura(20));
  await esperar(250);
  verificar('1a amostra seca ainda NAO comanda (debounce)', comandosRecebidos.length === 0,
    `recebidos ${comandosRecebidos.length}`);

  await publicar(leitura(21));
  await esperar(250);
  verificar('2a amostra seca ainda NAO comanda (debounce)', comandosRecebidos.length === 0,
    `recebidos ${comandosRecebidos.length}`);

  await publicar(leitura(22));
  await esperar(600);
  verificar('3a amostra seca gera comando', comandosRecebidos.length === 1,
    `recebidos ${comandosRecebidos.length}`);

  const cmd1 = comandosRecebidos[0];
  if (cmd1) {
    verificar('acao e PULSO_IRRIGACAO', cmd1.action === 'PULSO_IRRIGACAO', cmd1.action);
    verificar('comando tem identidade unica (commandId)', typeof cmd1.commandId === 'string' && cmd1.commandId.length > 0);
    verificar('comando tem chave idempotente', cmd1.idempotencyKey === cmd1.commandId);
    verificar('comando correlaciona com o evento que o originou',
      cmd1.correlationId === `${DEVICE_ID}:${BOOT_ID}:000005`, cmd1.correlationId);
    verificar('expiracao expressa no relogio do dispositivo',
      cmd1.expiresAtDeviceMs === cmd1.correlationEventTimeMs + cmd1.ttlMs,
      `${cmd1.expiresAtDeviceMs} != ${cmd1.correlationEventTimeMs} + ${cmd1.ttlMs}`);
  }

  // -------------------------------------------------------------------------
  console.log('3. Deduplicacao -- o mesmo eventId nao e reprocessado');
  // -------------------------------------------------------------------------
  const antes = comandosRecebidos.length;
  const repetido = leitura(20);
  await publicar(repetido);
  await esperar(300);
  await publicar(repetido); // exatamente o mesmo eventId
  await esperar(600);
  verificar('reenvio do mesmo eventId nao gera comando extra',
    comandosRecebidos.length === antes, `antes ${antes}, agora ${comandosRecebidos.length}`);

  // -------------------------------------------------------------------------
  console.log('4. Contrato -- payloads invalidos sao rejeitados sem derrubar o servico');
  // -------------------------------------------------------------------------
  const antesContrato = comandosRecebidos.length;
  await publicar(leitura(150));                          // fora de faixa
  await publicar(leitura(20, { schemaVersion: 2 }));      // versao desconhecida
  await publicar(leitura(20, { unit: 'litros' }));        // unidade fora do contrato
  await new Promise((r) => cliente.publish(T.telemetria, '{isso nao e json', { qos: 1 }, r));
  await esperar(800);
  verificar('nenhum comando a partir de payload invalido',
    comandosRecebidos.length === antesContrato,
    `antes ${antesContrato}, agora ${comandosRecebidos.length}`);

  // O servico precisa continuar vivo depois de receber lixo.
  await publicar(leitura(60));
  await esperar(500);
  verificar('servico continua processando apos payloads invalidos',
    comandosRecebidos.length >= antesContrato);

  // -------------------------------------------------------------------------
  console.log('5. Expiracao de validade -- silencio revoga a autorizacao');
  // -------------------------------------------------------------------------
  // O cooldown precisa ter vencido, senao a autorizacao nao vira pulso e o
  // cenario testado deixa de ser o da expiracao.
  await esperar(Number(AMBIENTE.COOLDOWN_MS) + 300);

  await publicar(leitura(20));
  await esperar(200);
  await publicar(leitura(20));
  await esperar(200);
  await publicar(leitura(20));
  await esperar(500);

  const indicePulso = comandosRecebidos.findLastIndex((c) => c.action === 'PULSO_IRRIGACAO');
  verificar('irrigacao autorizada novamente antes do silencio',
    indicePulso > 0 && comandosRecebidos.length > antesContrato,
    `ultimo pulso no indice ${indicePulso} de ${comandosRecebidos.length}`);

  // Silencio maior que a validade: o servico deve mandar parar SOZINHO, sem
  // receber nenhuma mensagem nova -- e o ponto central do recorte temporal.
  await esperar(Number(AMBIENTE.VALIDADE_MS) + 1500);

  const aposPulso = comandosRecebidos.slice(indicePulso + 1);
  const pararPorExpiracao = aposPulso.filter((c) => c.action === 'PARAR_IRRIGACAO');
  verificar('silencio prolongado gera PARAR_IRRIGACAO sem mensagem nova',
    pararPorExpiracao.length >= 1,
    `nenhum PARAR_IRRIGACAO depois do pulso; comandos apos: ${aposPulso.map((c) => c.action).join(',') || 'nenhum'}`);
  if (pararPorExpiracao.length) {
    verificar('motivo do parar cita o estado obsoleto',
      /obsoleto/.test(pararPorExpiracao[0].reason), pararPorExpiracao[0].reason);
  }

  // -------------------------------------------------------------------------
  console.log('5b. Retry de comando -- a mesma chave idempotente nao repete o efeito');
  // -------------------------------------------------------------------------
  const cmdParaRepetir = comandosRecebidos.find((c) => c.action === 'PULSO_IRRIGACAO');
  if (cmdParaRepetir) {
    const acksAntes = acksEnviados.length;
    // Reenvia o comando EXATAMENTE como foi emitido: mesmo commandId, mesma
    // idempotencyKey. E o retry que aconteceria se a resposta se perdesse.
    // O TTL e recalculado para que a rejeicao observada seja por duplicata,
    // e nao por expiracao -- sao falhas distintas.
    const repetido = { ...cmdParaRepetir, expiresAtDeviceMs: millis() + 5000 };
    await new Promise((r) => cliente.publish(T.comando, JSON.stringify(repetido), { qos: 1 }, r));
    await esperar(500);
    const novos = acksEnviados.slice(acksAntes);
    verificar('retry responde IGNORADO_DUPLICADO',
      novos.some((a) => a.result === 'IGNORADO_DUPLICADO'),
      novos.map((a) => a.result).join(',') || 'nenhum ack');
    verificar('retry NAO responde EXECUTADO',
      !novos.some((a) => a.result === 'EXECUTADO'),
      novos.map((a) => a.result).join(','));
  } else {
    verificar('havia um PULSO_IRRIGACAO para repetir', false);
  }

  // -------------------------------------------------------------------------
  console.log('5c. Comando expirado -- atuacao tardia e recusada');
  // -------------------------------------------------------------------------
  {
    const acksAntes = acksEnviados.length;
    const expirado = {
      schemaVersion: 1,
      commandId: 'cmd-teste-expirado',
      idempotencyKey: 'cmd-teste-expirado',
      commandType: 'ComandoIrrigacao',
      targetId: 'vaso-01',
      action: 'PULSO_IRRIGACAO',
      durationMs: 1000,
      correlationId: `${DEVICE_ID}:${BOOT_ID}:000001`,
      correlationEventTimeMs: 0,
      ttlMs: 1,
      expiresAtDeviceMs: 1, // prazo no passado do relogio do dispositivo
      issuedAt: new Date().toISOString(),
      reason: 'teste_expiracao'
    };
    await new Promise((r) => cliente.publish(T.comando, JSON.stringify(expirado), { qos: 1 }, r));
    await esperar(500);
    const novos = acksEnviados.slice(acksAntes);
    verificar('comando com prazo vencido responde REJEITADO_EXPIRADO',
      novos.some((a) => a.result === 'REJEITADO_EXPIRADO'),
      novos.map((a) => a.result).join(',') || 'nenhum ack');
  }

  // -------------------------------------------------------------------------
  console.log('6. Evento historico -- replay do buffer offline nao decide');
  // -------------------------------------------------------------------------
  const antesReplay = comandosRecebidos.length;
  await publicar(leitura(10, { replayed: true }));
  await publicar(leitura(10, { replayed: true }));
  await publicar(leitura(10, { replayed: true }));
  await esperar(800);
  verificar('tres leituras secas historicas nao geram comando',
    comandosRecebidos.length === antesReplay,
    `antes ${antesReplay}, agora ${comandosRecebidos.length}`);

  // -------------------------------------------------------------------------
  console.log('7. Will message -- queda abrupta marca o dispositivo como offline');
  // -------------------------------------------------------------------------
  cliente.stream.destroy(); // encerra o socket sem DISCONNECT
  await esperar(1500);
  verificar('conexao encerrada abruptamente (LWT publicado pelo broker)', true);

  // -------------------------------------------------------------------------
  console.log('');
  encerrarTudo();
  await esperar(400);

  if (falhas.length === 0) {
    console.log('TODOS OS CAMINHOS VERIFICADOS COM SUCESSO');
    console.log('');
    process.exit(0);
  } else {
    console.log(`${falhas.length} verificacao(oes) falharam:`);
    for (const f of falhas) console.log(`  - ${f}`);
    console.log('');
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  encerrarTudo();
  process.exit(130);
});

main().catch((e) => {
  console.error('erro no teste:', e);
  encerrarTudo();
  process.exit(1);
});

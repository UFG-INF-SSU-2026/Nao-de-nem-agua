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
const contrato = require('../contrato');
const seguranca = require('../seguranca');

const RAIZ = path.resolve(__dirname, '..');
let PORTA; // O sistema operacional escolhe uma porta local livre.

const AMBIENTE = {
  ...process.env,
  BROKER_PORT: String(PORTA),
  MQTT_URL: `mqtts://localhost:${PORTA}`,
  EXIGIR_ASSINATURA: '1',
  VALIDADE_MS: '2500',
  COOLDOWN_MS: '1200',
  COMANDO_TTL_MS: '2000',
  AMOSTRAS_DEBOUNCE: '3',
  LIMIAR_LIGA: '30',
  LIMIAR_DESLIGA: '50',
  // Marco 4: tempos das regras novas reduzidos para o teste (mesma logica).
  AMBIENTE_TEMPO_MINIMO_MS: '1000',
  AMBIENTE_CONCESSAO_MS: '8000',
  VERIFICACAO_JANELA_MS: '5000',
  VERIFICACAO_BLOQUEIO_MS: '8000',
  ADUBACAO_ABSORCAO_MS: '1500',
  ADUBACAO_COOLDOWN_TENTATIVA_MS: '2000',
  ADUBACAO_TIMEOUT_MEDICAO_MS: '10000',
  ADUBACAO_JANELA_VERIFICACAO_MS: '8000',
  ADUBACAO_JANELA_DOSES_MS: '120000',
  ADUBACAO_PULSO_MS: '2000',
  APP_ESTADO_INTERVALO_MS: '2000',
  LUZ_AMOSTRAS_MEDIA: '2',
  LUZ_TEMPO_MINIMO_MS: '3000',
  LUZ_VALIDADE_MS: '6000',
  // Marco 4: este teste cobre a fronteira e as regras, em memoria; a
  // persistencia tem o proprio teste (npm run teste:persistencia).
  PERSISTENCIA_HABILITADA: '0'
};

// O teste assume a identidade do gateway simulado: mesma senha, mesma ACL,
// mesma chave HMAC.
const DEVICE_ID = 'sim-vaso-01';
const CHAVE = seguranca.dispositivo(DEVICE_ID).chave;
const BOOT_ID = crypto.randomBytes(3).toString('hex');
const PREFIXO = 'naodenemagua/v1/vaso/vaso-01';
const T = {
  telemetria: `${PREFIXO}/telemetry/soil`,
  heartbeat: `${PREFIXO}/status/heartbeat`,
  comando: `${PREFIXO}/command/irrigacao`,
  ack: `${PREFIXO}/ack/irrigacao`,
  alerta: `${PREFIXO}/alert/cuidado`
};

let sequencia = 0;
const comandosRecebidos = [];
const falhas = [];
let aprovados = 0;
const alertas = [];
const conexoes = [];
let saidaNotificador = '';
let saidaBroker = '';
let saidaServico = '';
let saidaSimulador = '';
let simuladorProc = null;
let processos = [];

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function verificar(descricao, condicao, detalhe) {
  if (condicao) {
    aprovados += 1;
    console.log(`  ok    ${descricao}`);
  } else {
    console.log(`  FALHA ${descricao}${detalhe ? ` -- ${detalhe}` : ''}`);
    falhas.push(descricao);
  }
}

/* Conecta ao broker de teste com TLS + usuario/senha de uma identidade. */
function conectarComo(identidade, opcoes) {
  return contrato.conectar({ mqtt: { url: AMBIENTE.MQTT_URL } }, identidade, {
    clientId: `${identidade}-teste-${crypto.randomBytes(2).toString('hex')}`,
    ...(opcoes || {})
  });
}

/*
 * Tenta conectar e informa o desfecho, sem reconexao automatica.
 * Devolve { conectou, erro, cliente }.
 */
function tentarConectar(url, opcoes, ms) {
  return new Promise((resolve) => {
    const c = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: ms || 2500, ...opcoes });
    let fim = false;
    const terminar = (r) => {
      if (fim) return;
      fim = true;
      clearTimeout(t);
      if (!r.conectou) c.end(true);
      resolve({ ...r, cliente: c });
    };
    const t = setTimeout(() => terminar({ conectou: false, erro: 'sem CONNACK no prazo' }), (ms || 2500) + 500);
    c.on('connect', () => terminar({ conectou: true }));
    c.on('error', (e) => terminar({ conectou: false, erro: e.code !== undefined ? `${e.code} ${e.message}` : e.message }));
    c.on('close', () => terminar({ conectou: false, erro: 'conexao encerrada' }));
  });
}

/* Conexao "crua" a uma identidade, com controle total das opcoes. */
function opcoesDe(identidade, extras) {
  return {
    ca: seguranca.caPropria(),
    rejectUnauthorized: true,
    username: identidade,
    password: seguranca.senhaDe(identidade),
    clientId: `${identidade}-teste-${crypto.randomBytes(2).toString('hex')}`,
    ...(extras || {})
  };
}

function subir(rotulo, script, comTeclado) {
  const p = spawn(process.execPath, [path.join(RAIZ, script)], {
    env: comTeclado ? { ...AMBIENTE, SIMULADOR_TECLAS_STDIN: '1' } : AMBIENTE,
    stdio: [comTeclado ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });
  p.on('error', (e) => { console.error(rotulo, e); falhas.push(rotulo + ': ' + e.message); });
  p.stdout.on('data', (d) => {
    if (rotulo === 'notificador') saidaNotificador += d.toString();
    if (rotulo === 'broker') saidaBroker += d.toString();
    if (rotulo === 'servico') saidaServico += d.toString();
    if (rotulo === 'simulador') saidaSimulador += d.toString();
    if (process.env.VERBOSE) process.stdout.write(`    [${rotulo}] ${d}`);
  });
  p.stderr.on('data', (d) => process.stderr.write(`    [${rotulo} erro] ${d}`));
  processos.push(p);
  return p;
}

function encerrarTudo() {
  for (const c of conexoes) c.end(true);
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
  const reserva = require('net').createServer();
  await new Promise((r, j) => { reserva.once('error', j); reserva.listen(0, '127.0.0.1', r); });
  PORTA = reserva.address().port;
  await new Promise(r => reserva.close(r));
  AMBIENTE.BROKER_PORT = String(PORTA);
  // mqtts: o broker de teste so aceita TLS. O certificado vale para 127.0.0.1.
  AMBIENTE.MQTT_URL = `mqtts://127.0.0.1:${PORTA}`;
  // Não herdar identidades de uma demonstração aberta em outro terminal.
  AMBIENTE.TOPIC_PREFIX = 'naodenemagua/v1';
  AMBIENTE.VASO_ID = 'vaso-01';
  AMBIENTE.ALERTA_TTL_MS = '60000';
  console.log('');
  console.log('Teste de integracao da fronteira produtor <-> consumidor');
  console.log(`  broker de teste  ${AMBIENTE.MQTT_URL} (TLS + usuario/senha + ACL)`);
  console.log(`  validade=${AMBIENTE.VALIDADE_MS}ms cooldown=${AMBIENTE.COOLDOWN_MS}ms ttl=${AMBIENTE.COMANDO_TTL_MS}ms`);
  console.log('');

  // Certificados e senhas precisam existir antes de qualquer processo subir.
  seguranca.garantirMaterial();

  subir('broker', 'broker-local/broker.js');
  await esperar(1200);
  subir('servico', 'consumidor-servico/src/main.js');
  await esperar(1800);

  const cliente = conectarComo(DEVICE_ID, {
    clientId: `${DEVICE_ID}-${BOOT_ID}`,
    reconnectPeriod: 0,
    will: {
      topic: T.heartbeat,
      payload: seguranca.assinar(CHAVE, T.heartbeat, {
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

  conexoes.push(cliente);
  await new Promise((r) => cliente.on('connect', r));
  // Pela ACL o gateway so assina comandos do proprio vaso; alertas sao
  // acompanhados pelo "espiao", com a identidade do observador.
  await new Promise((r, j) => cliente.subscribe(T.comando, { qos: 1 }, e => e ? j(e) : r()));
  const notificador = subir('notificador', 'notificador/src/main.js');
  await esperar(800);

  /*
   * Comandos de teste (retry e expirado) precisam ser publicados por quem a ACL
   * autoriza a comandar: a identidade do servico. O gateway nao pode.
   */
  const comandante = conectarComo('servico-irrigacao', { reconnectPeriod: 0 });
  await new Promise((r) => comandante.on('connect', r));
  const publicarComando = (cmd) =>
    new Promise((r) => comandante.publish(T.comando, seguranca.assinar(CHAVE, T.comando, cmd), { qos: 1 }, r));

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
    cliente.publish(T.ack, seguranca.assinar(CHAVE, T.ack, ack), { qos: 1 });
    return ack;
  };

  const comandosSemAssinaturaValida = [];

  const tratarComando = (cmd, texto) => {
    if (!seguranca.verificarAssinatura(CHAVE, T.comando, texto).ok) {
      comandosSemAssinaturaValida.push(cmd);
      return responder(cmd, 'REJEITADO_ASSINATURA', 'hmac');
    }
    if (chavesAplicadas.has(cmd.idempotencyKey)) {
      return responder(cmd, 'IGNORADO_DUPLICADO', 'idempotencyKey ja aplicada');
    }
    if (millis() >= cmd.expiresAtDeviceMs) {
      return responder(cmd, 'REJEITADO_EXPIRADO', `millis=${millis()}`);
    }
    chavesAplicadas.add(cmd.idempotencyKey);
    return responder(cmd, 'EXECUTADO', cmd.action);
  };

  const espiao = conectarComo('observador', { reconnectPeriod: 0 });
  conexoes.push(espiao);
  await new Promise(r => espiao.once('connect',r));
  espiao.on('message',(t,b,p) => { try { alertas.push({...JSON.parse(b.toString()),qos:p.qos,retain:p.retain}); } catch { /* lixo intencional */ } });
  await new Promise((r,j) => espiao.subscribe(T.alerta,{qos:1},e => e ? j(e) : r()));
  cliente.on('message', (topico, buf, pacote) => {
    if (topico !== T.comando) return;
    const texto = buf.toString();
    const cmd = JSON.parse(texto);
    comandosRecebidos.push(cmd);
    tratarComando(cmd, texto);
  });

  const publicar = (payload) =>
    new Promise((r) => cliente.publish(T.telemetria, seguranca.assinar(CHAVE, T.telemetria, payload), { qos: 1 }, r));

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
    verificar('comando chega assinado pelo servico com a chave do dispositivo',
      comandosSemAssinaturaValida.length === 0, `${comandosSemAssinaturaValida.length} sem HMAC valido`);
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
  const leituraAposLixo = leitura(60);
  await publicar(leituraAposLixo);
  await esperar(500);
  verificar('servico continua processando apos payloads invalidos',
    comandosRecebidos.slice(antesContrato).some(c =>
      c.action === 'PARAR_IRRIGACAO' && c.correlationId === leituraAposLixo.eventId));

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
    delete repetido.sig;
    await publicarComando(repetido);
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
    await publicarComando(expirado);
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
  cliente.options.reconnectPeriod = 0;
  cliente.stream.destroy(); // encerra o socket sem DISCONNECT
  await esperar(1500);
  verificar('conexao encerrada abruptamente (LWT publicado pelo broker)', true);

  console.log('8. Alertas de cuidado — serviço produtor e notificador consumidor');
  const porTipo = tipo => alertas.filter(a => a.alertType === tipo);
  verificar('cada ciclo seco produz somente um SOLO_SECO', porTipo('SOLO_SECO').length === 2);
  verificar('pulso confirmado gera IRRIGACAO_EXECUTADA', porTipo('IRRIGACAO_EXECUTADA').some(a => a.correlationId === cmd1?.commandId));
  verificar('parada EXECUTADO nao gera alerta de irrigacao executada', porTipo('IRRIGACAO_EXECUTADA').every(a => comandosRecebidos.find(c => c.commandId === a.correlationId)?.action === 'PULSO_IRRIGACAO'));
  verificar('validade expirada gera DADO_OBSOLETO', porTipo('DADO_OBSOLETO').length >= 1);
  verificar('LWT real gera DISPOSITIVO_OFFLINE uma vez', porTipo('DISPOSITIVO_OFFLINE').length === 1);
  verificar('LWT sem eventId correlaciona com deviceId existente', porTipo('DISPOSITIVO_OFFLINE')[0]?.correlationId === DEVICE_ID);
  verificar('SOLO_SECO correlaciona com terceira leitura', porTipo('SOLO_SECO')[0]?.correlationId === cmd1?.correlationId);
  verificar('alertas MQTT usam QoS 1 e retain false', alertas.length > 0 && alertas.every(a => a.qos === 1 && a.retain === false));
  const publicacoes = saidaBroker.split('\n').filter(l => l.includes('PUBLISH') && l.includes('/alert/cuidado'));
  verificar('broker recebe alertas QoS 1 sem flag retained', publicacoes.length > 0 && publicacoes.every(l => l.includes('QoS 1') && !l.includes('[retained]')));

  /*
   * Marco 3: cada papel com a propria identidade, como na ACL. O gateway
   * publica heartbeat, telemetria e ack ASSINADOS e assina os comandos; o
   * servico publica os alertas de teste que o notificador deve descartar.
   */
  const controle = conectarComo(DEVICE_ID, { reconnectPeriod: 0 });
  const servicoTeste = conectarComo('servico-irrigacao', { reconnectPeriod: 0 });
  conexoes.push(controle, servicoTeste);
  await Promise.all([controle, servicoTeste].map(c => new Promise(r => c.once('connect', r))));
  await new Promise((r,j) => controle.subscribe(T.comando, {qos:1}, e => e ? j(e) : r()));
  controle.on('message', (t,b,p) => {
    let obj; try { obj = JSON.parse(b.toString()); } catch { return; }

    if(t === T.comando) comandosRecebidos.push(obj);
  });
  const enviar = (t,p) => {
    const ehAlerta = t === T.alerta;
    const texto = typeof p === 'string' ? p : ehAlerta ? JSON.stringify(p) : seguranca.assinar(CHAVE, t, p);
    const via = ehAlerta ? servicoTeste : controle;
    return new Promise((r,j) => via.publish(t, texto, {qos:1}, e => e ? j(e) : r()));
  };
  const offline = {schemaVersion:1,eventType:'EstadoConectividade',deviceId:DEVICE_ID,entityId:'vaso-01',bootId:BOOT_ID,state:'OFFLINE'};
  await enviar(T.heartbeat, offline);
  await enviar(T.telemetria, leitura(5,{replayed:true,valid:false,invalidReason:'historico'}));
  await enviar(T.heartbeat, offline);
  await esperar(200);
  verificar('OFFLINE repetido e replay invalido nao repetem alerta',porTipo('DISPOSITIVO_OFFLINE').length === 1);
  const recuperacao = leitura(60);
  await enviar(T.telemetria, recuperacao);
  await esperar(250);
  verificar('recuperacao para NORMAL correlaciona leitura',porTipo('DISPOSITIVO_RECUPERADO').some(a => a.correlationId === recuperacao.eventId));

  await esperar(Number(AMBIENTE.COOLDOWN_MS));
  for(let i=0;i<3;i++) await enviar(T.telemetria,leitura(20));
  await esperar(200);
  const pulsoA = comandosRecebidos.at(-1);
  await esperar(Number(AMBIENTE.COOLDOWN_MS));
  await enviar(T.telemetria,leitura(20));
  await esperar(200);
  const pulsoB = comandosRecebidos.at(-1);
  const ack = (c,result) => ({schemaVersion:1,eventType:'ConfirmacaoAtuacao',deviceId:DEVICE_ID,bootId:BOOT_ID,commandId:c.commandId,correlationId:c.correlationId,result,appliedAtDeviceMs:millis()});
  await enviar(T.ack,ack(pulsoB,'REJEITADO_CONTRATO'));
  await enviar(T.ack,ack(pulsoA,'REJEITADO_EXPIRADO'));
  await enviar(T.ack,ack(pulsoA,'REJEITADO_EXPIRADO'));
  await esperar(250);
  verificar('acks de pulsos fora de ordem geram duas recusas correlacionadas',porTipo('IRRIGACAO_RECUSADA').filter(a => [pulsoA.commandId,pulsoB.commandId].includes(a.correlationId)).length === 2);
  const antesExec = porTipo('IRRIGACAO_EXECUTADA').length;
  await enviar(T.ack,ack(pulsoB,'EXECUTADO'));
  await enviar(T.ack,ack(pulsoA,'IGNORADO_DUPLICADO'));
  await esperar(200);
  verificar('ack terminal repetido ou IGNORADO_DUPLICADO nao produz execucao',porTipo('IRRIGACAO_EXECUTADA').length === antesExec);

  // O retry pode responder antes que a confirmação original atravesse a rede.
  await esperar(Number(AMBIENTE.COOLDOWN_MS));
  await enviar(T.telemetria, leitura(20));
  await esperar(200);
  const pulsoC = comandosRecebidos.at(-1);
  await enviar(T.ack, ack(pulsoC, 'IGNORADO_DUPLICADO'));
  await esperar(150);
  verificar('IGNORADO_DUPLICADO isolado nao indica nova execucao', porTipo('IRRIGACAO_EXECUTADA').length === antesExec);
  await enviar(T.ack, ack(pulsoC, 'EXECUTADO'));
  await enviar(T.ack, ack(pulsoC, 'EXECUTADO'));
  await esperar(250);
  verificar('EXECUTADO original apos retry gera exatamente um alerta', porTipo('IRRIGACAO_EXECUTADA').filter(a => a.correlationId === pulsoC.commandId).length === 1);

  const modelo = {schemaVersion:1,eventId:'teste-alerta:000001',eventType:'AlertaCuidado',producerId:'servico-irrigacao',entityId:'vaso-01',alertType:'SOLO_SECO',severity:'ATENCAO',message:'Teste do consumidor',correlationId:recuperacao.eventId,issuedAt:new Date().toISOString(),ttlMs:60000};
  await enviar(T.alerta,modelo);
  await enviar(T.alerta,modelo);
  await enviar(T.alerta,{...modelo,eventId:'expirado',issuedAt:new Date(Date.now()-120000).toISOString()});
  await enviar(T.alerta,'{invalido');
  await enviar(T.alerta,{...modelo,eventId:'versao',schemaVersion:2});
  await enviar(T.alerta,{...modelo,eventId:'schema',severity:'DESCONHECIDO'});
  await enviar(T.alerta,{...modelo,eventId:'data-impossivel',issuedAt:'2026-02-30T12:00:00.000Z'});
  await enviar(T.alerta,{...modelo,eventId:'apos-lixo'});
  await esperar(500);
  verificar('notificador descarta eventId duplicado',/DUPLICADO.*teste-alerta:000001/.test(saidaNotificador));
  verificar('notificador descarta alerta vencido',/EXPIRADO.*expirado/.test(saidaNotificador));
  verificar('notificador registra JSON malformado',saidaNotificador.includes('JSON_MALFORMADO'));
  verificar('notificador registra versao desconhecida',saidaNotificador.includes('VERSAO_NAO_SUPORTADA'));
  verificar('notificador registra schema e data impossivel',/SCHEMA_INVALIDO.*schema/.test(saidaNotificador) && /SCHEMA_INVALIDO.*data-impossivel/.test(saidaNotificador));
  verificar('notificador continua vivo e exibe cartao apos lixo',notificador.exitCode === null && saidaNotificador.includes('apos-lixo') && saidaNotificador.includes('╔'));

  await secaoSeguranca(comandante);
  await secaoMarco4(comandante);

  // -------------------------------------------------------------------------
  console.log(`Resultado: ${aprovados} passaram; ${falhas.length} falharam`);
  console.log('');
  comandante.end(true);
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

// ---------------------------------------------------------------------------
// Marco 3 -- seguranca: canal, identidade, autorizacao e autenticidade
// ---------------------------------------------------------------------------

async function secaoSeguranca(comandante) {
  const url = AMBIENTE.MQTT_URL;

  // A secao anterior termina com irrigacao em curso. Deixa a validade vencer e
  // o PARAR por expiracao sair ANTES de vigiar o topico de comando.
  await esperar(Number(AMBIENTE.VALIDADE_MS) + 1000);

  // -------------------------------------------------------------------------
  console.log('9. Canal -- so TLS, e so com o broker certo');
  // -------------------------------------------------------------------------
  {
    const r = await tentarConectar(`mqtt://localhost:${PORTA}`, opcoesDe('observador'));
    verificar('MQTT em texto puro na porta do broker NAO conecta', !r.conectou, r.erro);
  }
  {
    // Sem a nossa CA, o cliente nao tem como saber que o certificado e legitimo.
    const r = await tentarConectar(url, opcoesDe('observador', { ca: undefined }));
    verificar('cliente que nao confia na CA propria recusa o broker (anti-MITM)', !r.conectou, r.erro);
  }

  // -------------------------------------------------------------------------
  console.log('10. Identidade -- o broker so aceita quem ele conhece');
  // -------------------------------------------------------------------------
  {
    const r = await tentarConectar(url, opcoesDe('observador', { username: undefined, password: undefined }));
    verificar('conexao sem usuario/senha e recusada', !r.conectou, r.erro);
  }
  {
    const r = await tentarConectar(url, opcoesDe('sim-vaso-01', { password: 'senha-errada' }));
    verificar('senha errada e recusada', !r.conectou, r.erro);
  }
  {
    const r = await tentarConectar(url, opcoesDe('servico-irrigacao', { username: 'intruso', password: 'x' }));
    verificar('usuario inexistente e recusado', !r.conectou, r.erro);
  }
  {
    // Identidade valida tentando usar o clientId de outra -- tomaria a sessao dela.
    const r = await tentarConectar(url, opcoesDe('observador', { clientId: 'servico-irrigacao-sequestro' }));
    verificar('clientId de outra identidade e recusado', !r.conectou, r.erro);
  }
  {
    const r = await tentarConectar(url, opcoesDe('notificador'));
    verificar('identidade valida conecta (controle positivo)', r.conectou, r.erro);
    r.cliente.end(true);
  }

  // -------------------------------------------------------------------------
  console.log('11. Autorizacao -- cada identidade so faz o que o seu papel permite');
  // -------------------------------------------------------------------------
  // Vigia o topico de comando com a identidade do gateway (a unica que o assina).
  const vigia = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
  const vistosNoComando = [];
  await new Promise((r) => vigia.subscribe(T.comando, { qos: 1 }, r));
  vigia.on('message', (t, b) => vistosNoComando.push(b.toString()));
  // Conta so o que interessa a cada verificacao: o comando forjado e os pulsos.
  const forjadosVistos = () => vistosNoComando.filter((m) => m.includes('forjado')).length;
  const pulsosVistos = () => vistosNoComando.filter((m) => m.includes('"PULSO_IRRIGACAO"')).length;

  {
    const n = (await tentarConectar(url, opcoesDe('notificador'))).cliente;
    const caiu = new Promise((r) => n.on('close', () => r(true)));
    n.publish(T.comando, JSON.stringify({ forjado: true, action: 'PULSO_IRRIGACAO' }), { qos: 1 });
    const derrubado = await Promise.race([caiu, esperar(1500).then(() => false)]);
    await esperar(300);
    verificar('notificador NAO consegue publicar comando', forjadosVistos() === 0,
      `${forjadosVistos()} mensagem(ns) forjada(s) chegaram ao topico de comando`);
    verificar('broker derruba quem publica fora da ACL', derrubado);
    n.end(true);
  }
  {
    const o = (await tentarConectar(url, opcoesDe('observador'))).cliente;
    o.publish(T.telemetria, JSON.stringify({ forjado: true }), { qos: 1 });
    await esperar(500);
    verificar('observador (somente leitura) NAO publica', o.connected === false, 'continuou conectado');
    o.end(true);
  }
  {
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    const concedido = await new Promise((r) =>
      g.subscribe('naodenemagua/v1/vaso/vaso-02/command/irrigacao', { qos: 1 }, (e) => r(e)));
    // O mqtt.js entrega o SUBACK 0x80 como erro "Subscribe error".
    verificar('gateway NAO assina comandos de outro vaso (SUBACK 0x80)',
      concedido && /Subscribe error/.test(concedido.message), concedido ? concedido.message : 'assinatura concedida');
    const curinga = await new Promise((r) =>
      g.subscribe('naodenemagua/v1/vaso/+/command/irrigacao', { qos: 1 }, (e) => r(e)));
    verificar('gateway NAO assina comandos de todos os vasos por curinga',
      curinga && /Subscribe error/.test(curinga.message), curinga ? curinga.message : 'assinatura concedida');
    g.end(true);
  }
  {
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    const alheio = 'naodenemagua/v1/vaso/vaso-02/telemetry/soil';
    g.publish(alheio, seguranca.assinar(CHAVE, alheio, leitura(20)), { qos: 1 });
    await esperar(500);
    verificar('gateway NAO publica telemetria de outro vaso', g.connected === false, 'continuou conectado');
    g.end(true);
  }
  {
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    g.publish(T.telemetria, JSON.stringify({ ...leitura(20), deviceId: 'esp32-vaso-01' }), { qos: 1 });
    await esperar(500);
    verificar('gateway NAO publica com deviceId de outro dispositivo', g.connected === false, 'continuou conectado');
    g.end(true);
  }

  // -------------------------------------------------------------------------
  console.log('12. Autenticidade (HMAC) -- o servico so decide sobre mensagem assinada');
  // -------------------------------------------------------------------------
  {
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    const pub = (texto) => new Promise((r) => g.publish(T.telemetria, texto, { qos: 1 }, r));

    // Tres leituras secas SEM assinatura: bastariam para irrigar, se aceitas.
    for (let i = 0; i < 3; i++) await pub(JSON.stringify(leitura(20)));
    await esperar(600);
    verificar('leituras secas sem assinatura NAO geram comando', pulsosVistos() === 0,
      `${pulsosVistos()} pulso(s)`);

    // Tres leituras assinadas como 60% e adulteradas para 20% depois.
    for (let i = 0; i < 3; i++) {
      await pub(seguranca.assinar(CHAVE, T.telemetria, leitura(60)).replace('"value":60', '"value":20'));
    }
    await esperar(600);
    verificar('leituras adulteradas apos assinar NAO geram comando', pulsosVistos() === 0,
      `${pulsosVistos()} pulso(s)`);

    // Assinadas com a chave ERRADA (um atacante que conhece o formato, nao a chave).
    const chaveFalsa = crypto.randomBytes(32).toString('hex');
    for (let i = 0; i < 3; i++) await pub(seguranca.assinar(chaveFalsa, T.telemetria, leitura(20)));
    await esperar(600);
    verificar('leituras assinadas com chave errada NAO geram comando', pulsosVistos() === 0,
      `${pulsosVistos()} pulso(s)`);

    // Controle positivo: as mesmas tres leituras, assinadas de verdade.
    await esperar(Number(AMBIENTE.COOLDOWN_MS));
    for (let i = 0; i < 3; i++) {
      await pub(seguranca.assinar(CHAVE, T.telemetria, leitura(20)));
      await esperar(150);
    }
    await esperar(700);
    verificar('as mesmas leituras, assinadas de verdade, geram comando (controle positivo)',
      pulsosVistos() >= 1, 'nenhum pulso');
    g.end(true);
  }
  vigia.end(true);

  // -------------------------------------------------------------------------
  console.log('13. Ultima barreira -- o dispositivo recusa comando nao assinado pelo servico');
  // -------------------------------------------------------------------------
  {
    // O simulador real e o dispositivo aqui: o teste so forja o comando.
    // Marco 4: sobe com "teclado" por pipe, usado nas secoes 14 a 18.
    simuladorProc = subir('simulador', 'simulador-produtor/src/main.js', true);
    await esperar(1500);

    const acks = [];
    await new Promise((r) => comandante.subscribe(T.ack, { qos: 1 }, r));
    comandante.on('message', (t, b) => {
      if (t === T.ack) acks.push(JSON.parse(b.toString()));
    });

    const forjado = {
      schemaVersion: 1,
      commandId: 'cmd-forjado',
      idempotencyKey: 'cmd-forjado',
      commandType: 'ComandoIrrigacao',
      targetId: 'vaso-01',
      action: 'PULSO_IRRIGACAO',
      durationMs: 60000,
      correlationId: 'forjado:0:0',
      correlationEventTimeMs: 0,
      ttlMs: 9999999,
      expiresAtDeviceMs: 9999999,
      reason: 'ataque'
    };
    const chaveFalsa = crypto.randomBytes(32).toString('hex');
    comandante.publish(T.comando, seguranca.assinar(chaveFalsa, T.comando, forjado), { qos: 1 });
    comandante.publish(T.comando, JSON.stringify({ ...forjado, commandId: 'cmd-sem-sig', idempotencyKey: 'cmd-sem-sig' }), { qos: 1 });
    await esperar(1000);

    const doForjado = acks.filter((a) => a.commandId === 'cmd-forjado');
    const doSemSig = acks.filter((a) => a.commandId === 'cmd-sem-sig');
    verificar('comando com assinatura falsa -> REJEITADO_ASSINATURA',
      doForjado.length > 0 && doForjado.every((a) => a.result === 'REJEITADO_ASSINATURA'),
      doForjado.map((a) => a.result).join(',') || 'nenhum ack');
    verificar('comando sem assinatura -> REJEITADO_ASSINATURA',
      doSemSig.length > 0 && doSemSig.every((a) => a.result === 'REJEITADO_ASSINATURA'),
      doSemSig.map((a) => a.result).join(',') || 'nenhum ack');
  }
}

// ---------------------------------------------------------------------------
// Marco 4 -- sensores novos, umidificador, reservatorios, adubacao
// ---------------------------------------------------------------------------

/*
 * Daqui em diante o dispositivo e o SIMULADOR real (subiu na secao 13), com a
 * fisica simples declarada: bomba sobe a umidade e baixa o reservatorio, dose
 * sobe a EC, umidificador sobe a umidade do ar. O teste "aperta as teclas" da
 * demonstracao por um pipe e observa a fronteira com a identidade do
 * observador. Nada aqui fala com o servico por fora do broker.
 */
async function secaoMarco4(comandante) {
  const sim = (teclas) => simuladorProc.stdin.write(teclas);
  const T4 = {
    ambiente: `${PREFIXO}/telemetry/ambient`,
    nivel: `${PREFIXO}/telemetry/reservoir`,
    atuador: `${PREFIXO}/command/atuador`,
    ackAtuador: `${PREFIXO}/ack/atuador`
  };

  const olho = conectarComo('observador', { reconnectPeriod: 0 });
  conexoes.push(olho);
  await new Promise((r) => olho.once('connect', r));
  const vistos = [];
  olho.on('message', (t, b) => {
    try { vistos.push({ t, p: JSON.parse(b.toString()), em: Date.now() }); } catch { /* ignora */ }
  });
  await new Promise((r, j) => olho.subscribe(
    [`${PREFIXO}/telemetry/#`, `${PREFIXO}/command/#`, `${PREFIXO}/ack/#`], { qos: 1 }, (e) => (e ? j(e) : r())));

  const desde = (m) => vistos.filter((v) => v.em >= m);
  const comandosAtu = (m) => desde(m).filter((v) => v.t === T4.atuador).map((v) => v.p);
  const acksAtu = (m) => desde(m).filter((v) => v.t === T4.ackAtuador).map((v) => v.p);
  const pulsos = (m) => desde(m).filter((v) => v.t === T.comando && v.p.action === 'PULSO_IRRIGACAO').map((v) => v.p);
  const acksIrr = (m) => desde(m).filter((v) => v.t === T.ack).map((v) => v.p);
  const alertasDesde = (m, tipo) => alertas.filter((a) => a.alertType === tipo && Date.parse(a.issuedAt) >= m - 100);
  const aguardar = async (cond, ms) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (cond()) return true;
      await esperar(200);
    }
    return cond();
  };
  const comandoAssinado = (topico, cmd) =>
    new Promise((r) => comandante.publish(topico, seguranca.assinar(CHAVE, topico, cmd), { qos: 1 }, r));
  const baseComando = (id, extra) => ({
    schemaVersion: 1, commandId: id, idempotencyKey: id, targetId: 'vaso-01',
    correlationId: 'teste-marco4:0:0', correlationEventTimeMs: 0, ttlMs: 9999999,
    expiresAtDeviceMs: 9999999, reason: 'teste_protecao_local', ...extra
  });

  // -------------------------------------------------------------------------
  console.log('14. Marco 4 -- telemetria nova atravessa a fronteira assinada e no contrato');
  // -------------------------------------------------------------------------
  await esperar(3500);
  {
    const doSim = vistos.filter((v) => v.p.deviceId === 'sim-vaso-01' && v.t.includes('/telemetry/'));
    const amb = doSim.filter((v) => v.t === T4.ambiente);
    const niv = doSim.filter((v) => v.t === T4.nivel);
    const solo = doSim.filter((v) => v.t === T.telemetria);
    verificar('LeituraAmbiente publicada, assinada e dentro do contrato',
      amb.length > 0 && amb.every((v) => v.p.sig && contrato.validar('LeituraAmbiente', v.p).ok), `${amb.length} leituras`);
    verificar('NivelReservatorio de AGUA e de ADUBO, assinados e dentro do contrato',
      ['AGUA', 'ADUBO'].every((r) => niv.some((v) => v.p.reservoir === r)) &&
      niv.every((v) => v.p.sig && contrato.validar('NivelReservatorio', v.p).ok), `${niv.length} leituras`);
    verificar('LeituraUmidadeSolo traz EC compensada nos campos opcionais da v1',
      solo.some((v) => v.p.ecValid === true && typeof v.p.ec25UsCm === 'number') &&
      solo.every((v) => contrato.validar('LeituraUmidadeSolo', v.p).ok));
    const ids = doSim.map((v) => v.p.eventId);
    verificar('eventId unico entre solo, ar e nivel (sequence compartilhado)', new Set(ids).size === ids.length);
  }

  // -------------------------------------------------------------------------
  console.log('15. R1 -- umidade do ar governa o umidificador por concessao');
  // -------------------------------------------------------------------------
  {
    const m = Date.now();
    sim('h');
    const ligou = await aguardar(() => comandosAtu(m).some((c) => c.actuator === 'UMIDIFICADOR' && c.action === 'LIGAR'), 12000);
    const ligar = comandosAtu(m).find((c) => c.actuator === 'UMIDIFICADOR' && c.action === 'LIGAR');
    verificar('ar seco (35%): servico manda LIGAR o umidificador', ligou);
    verificar('LIGAR e uma concessao com prazo (durationMs)', ligar && ligar.durationMs === Number(AMBIENTE.AMBIENTE_CONCESSAO_MS), ligar && ligar.durationMs);
    verificar('dispositivo confirma EXECUTADO no topico ack/atuador',
      !!ligar && await aguardar(() => acksAtu(m).some((a) => a.commandId === ligar.commandId && a.result === 'EXECUTADO'), 3000));
    verificar('alerta UMIDIFICADOR_ACIONADO', await aguardar(() => alertasDesde(m, 'UMIDIFICADOR_ACIONADO').length === 1, 3000));
    verificar('ar umidificado acima de min+histerese: DESLIGAR (umidade_ar_atingiu_alvo)',
      await aguardar(() => comandosAtu(m).some((c) => c.actuator === 'UMIDIFICADOR' && c.action === 'DESLIGAR' && c.reason === 'umidade_ar_atingiu_alvo'), 25000));

    const m2 = Date.now();
    sim('h');
    await aguardar(() => comandosAtu(m2).some((c) => c.actuator === 'UMIDIFICADOR' && c.action === 'LIGAR'), 12000);
    const m3 = Date.now();
    sim('z');
    verificar('DHT22 em falha: alerta SENSOR_FALHOU', await aguardar(() => alertasDesde(m3, 'SENSOR_FALHOU').length >= 1, 5000));
    verificar('DHT22 em falha: umidificador DESLIGADO por seguranca',
      comandosAtu(m3).some((c) => c.actuator === 'UMIDIFICADOR' && c.action === 'DESLIGAR' && /^sensor_ar_/.test(c.reason)));
    sim('zj');
    verificar('DHT22 de volta: alerta SENSOR_RECUPERADO', await aguardar(() => alertasDesde(m3, 'SENSOR_RECUPERADO').length >= 1, 5000));
  }

  // -------------------------------------------------------------------------
  console.log('16. R4 -- reservatorio critico bloqueia a bomba no servico E no dispositivo');
  // -------------------------------------------------------------------------
  let m16;
  {
    const m = Date.now();
    m16 = m;
    sim('r');
    verificar('reservatorio de agua a 5%: alerta RESERVATORIO_CRITICO',
      await aguardar(() => alertasDesde(m, 'RESERVATORIO_CRITICO').length === 1, 5000));
    sim('s');
    await esperar(6000);
    verificar('solo seco com reservatorio critico: servico NAO pede irrigacao', pulsos(m).length === 0, `${pulsos(m).length} pulso(s)`);

    // Ultima barreira fisica: um comando autentico e no prazo, mas perigoso.
    await comandoAssinado(T.comando, baseComando('cmd-teste-seguranca', { commandType: 'ComandoIrrigacao', action: 'PULSO_IRRIGACAO', durationMs: 3000 }));
    verificar('dispositivo recusa PULSO_IRRIGACAO com reservatorio critico -> REJEITADO_SEGURANCA',
      await aguardar(() => acksIrr(m).some((a) => a.commandId === 'cmd-teste-seguranca' && a.result === 'REJEITADO_SEGURANCA' && a.detail === 'reservatorio_agua_critico'), 3000));
    await comandoAssinado(T4.atuador, baseComando('atu-teste-solo-seco', { commandType: 'ComandoAtuador', actuator: 'BOMBA_ADUBO', action: 'PULSO', durationMs: 2000 }));
    verificar('dispositivo recusa dose de adubo em solo seco -> REJEITADO_SEGURANCA',
      await aguardar(() => acksAtu(m).some((a) => a.commandId === 'atu-teste-solo-seco' && a.result === 'REJEITADO_SEGURANCA' && a.detail === 'solo_seco_nao_adubar'), 3000));

    const mw = Date.now();
    sim('w');
    verificar('reabastecido: alerta RESERVATORIO_NORMALIZADO', await aguardar(() => alertasDesde(mw, 'RESERVATORIO_NORMALIZADO').length >= 1, 5000));
    verificar('com agua de novo, a irrigacao volta', await aguardar(() => pulsos(mw).length >= 1, 8000));
    verificar('R2 verifica o EFEITO: umidade subiu E nivel caiu', await aguardar(() => /efeito confirmado/.test(saidaServico), 10000));
    verificar('pulso com efeito NAO gera FALHA_IRRIGACAO', alertasDesde(mw, 'FALHA_IRRIGACAO').length === 0);
  }

  // -------------------------------------------------------------------------
  console.log('17. R3 -- adubacao confirmada por medicao, com limite de doses');
  // -------------------------------------------------------------------------
  {
    // So as doses que o SERVICO decidiu -- os comandos forjados pelo proprio
    // teste (atu-teste-*) tambem passam pelo topico e nao contam.
    const doseDesde = (m) => comandosAtu(m).filter((c) =>
      c.actuator === 'BOMBA_ADUBO' && c.action === 'PULSO' && !c.commandId.startsWith('atu-teste'));
    // A secao 16 deixou o solo a 20% com EC normal: EC aparente baixa so por
    // falta de agua. A R3 deve irrigar antes, medir de novo e NAO adubar.
    verificar('EC baixa so por solo seco: irriga, mede de novo e NAO aduba (falso positivo evitado)',
      await aguardar(() => /falso_positivo_evitado/.test(saidaServico), 20000) && doseDesde(m16).length === 0,
      `${doseDesde(m16).length} dose(s)`);

    const m = Date.now();
    sim('mn');
    const dosou = await aguardar(() => doseDesde(m).length >= 1, 25000);
    const dose = doseDesde(m)[0];
    verificar('EC baixa (500) com solo umido: dose de fertilizante', dosou);
    verificar('dose e um PULSO com duracao configurada', dose && dose.durationMs === Number(AMBIENTE.ADUBACAO_PULSO_MS));
    verificar('dispositivo executa a dose', !!dose && await aguardar(() => acksAtu(m).some((a) => a.commandId === dose.commandId && a.result === 'EXECUTADO'), 3000));
    verificar('EC subiu e nivel do adubo caiu: alerta ADUBACAO_EXECUTADA',
      await aguardar(() => alertasDesde(m, 'ADUBACAO_EXECUTADA').length === 1, 15000));

    const ml = Date.now();
    sim('n');
    await esperar(10000);
    verificar('EC baixa de novo dentro da janela: limite de doses segura a segunda dose', doseDesde(ml).length === 0,
      `${doseDesde(ml).length} dose(s)`);
    verificar('servico registra limite_de_doses_na_janela', /limite_de_doses_na_janela/.test(saidaServico));

    const mb = Date.now();
    sim('b');
    verificar('EC alta (2500): alerta EXCESSO_NUTRIENTES, sem atuacao',
      await aguardar(() => alertasDesde(mb, 'EXCESSO_NUTRIENTES').length === 1, 8000) && doseDesde(mb).length === 0);

    // Intertravamento no dispositivo: agua e adubo nunca juntos.
    const mi = Date.now();
    await comandoAssinado(T.comando, baseComando('cmd-teste-intertravamento', { commandType: 'ComandoIrrigacao', action: 'PULSO_IRRIGACAO', durationMs: 3000 }));
    await esperar(300);
    await comandoAssinado(T4.atuador, baseComando('atu-teste-intertravamento', { commandType: 'ComandoAtuador', actuator: 'BOMBA_ADUBO', action: 'PULSO', durationMs: 2000 }));
    verificar('dispositivo recusa adubo com a bomba de agua ligada (intertravamento)',
      await aguardar(() => acksAtu(mi).some((a) => a.commandId === 'atu-teste-intertravamento' && a.result === 'REJEITADO_SEGURANCA' && a.detail === 'intertravamento_bomba_agua'), 3000));
    sim('l');
    await esperar(3500);
  }

  // -------------------------------------------------------------------------
  console.log('18. R2 -- bomba sem fluxo: validacao cruzada detecta e bloqueia');
  // -------------------------------------------------------------------------
  {
    const m = Date.now();
    sim('fs');
    verificar('pulso EXECUTADO sem efeito: alerta FALHA_IRRIGACAO (bomba_sem_fluxo)',
      await aguardar(() => alertasDesde(m, 'FALHA_IRRIGACAO').some((a) => /bomba_sem_fluxo/.test(a.message)), 20000));
    const mb = Date.now();
    await esperar(4000);
    verificar('irrigacao automatica bloqueada depois da falha', pulsos(mb).length === 0, `${pulsos(mb).length} pulso(s)`);
    sim('f');
    verificar('bloqueio expira (sem app para reconhecer) e a irrigacao volta',
      await aguardar(() => pulsos(mb).length >= 1, 15000));
    verificar('notificador apresenta os alertas novos', /RESERVATORIO CRITICO/.test(saidaNotificador) && /FALHA IRRIGACAO/.test(saidaNotificador));
    sim('m');
  }

  // -------------------------------------------------------------------------
  console.log('19. Marco 4 -- aplicativo: identidade propria, estado retido, reconhecimento de falha');
  // -------------------------------------------------------------------------
  {
    const TA = {
      estado: `${PREFIXO}/state/vaso`,
      solicitacao: `${PREFIXO}/app/solicitacao`,
      resposta: `${PREFIXO}/app/resposta`
    };
    const url = AMBIENTE.MQTT_URL;

    // O teste faz o papel do app Android: mesma identidade, mesma ACL.
    const conexaoApp = await tentarConectar(url, opcoesDe('app-vaso-01'));
    verificar('app conecta com TLS + usuario/senha proprios (app-vaso-01)', conexaoApp.conectou, conexaoApp.erro);
    const app = conexaoApp.cliente;
    conexoes.push(app);
    const estados = [];
    const respostas = [];
    app.on('message', (t, b, pk) => {
      try {
        const p = JSON.parse(b.toString());
        if (t === TA.estado) estados.push({ p, retain: pk.retain, em: Date.now() });
        if (t === TA.resposta) respostas.push(p);
      } catch { /* ignora */ }
    });
    // SUBACK: 128 = assinatura negada pela ACL.
    const assinar = (filtro) => new Promise((r) => app.subscribe(filtro, { qos: 1 }, (e, g) => r(e ? 128 : g[0].qos)));

    const qosEstado = await assinar(TA.estado);
    const qosAlertas = await assinar(`${PREFIXO}/alert/#`);
    const qosResposta = await assinar(TA.resposta);
    verificar('app assina estado, alertas e respostas do proprio vaso',
      qosEstado !== 128 && qosAlertas !== 128 && qosResposta !== 128, `SUBACK ${qosEstado}/${qosAlertas}/${qosResposta}`);
    verificar('ao assinar, o app recebe o EstadoVaso RETIDO na hora, dentro do contrato',
      await aguardar(() => estados.some((e) => e.retain), 2000) && contrato.validar('EstadoVaso', estados[0].p).ok,
      estados.length ? JSON.stringify(contrato.validar('EstadoVaso', estados[0].p)) : 'nada recebido');
    const n0 = estados.length;
    await esperar(Number(AMBIENTE.APP_ESTADO_INTERVALO_MS) + 1000);
    verificar('sem mudanca, o estado e republicado no pulso (o app distingue "parado" de "sem novidade")',
      estados.length > n0, `${estados.length - n0} publicacao(oes)`);
    verificar('app NAO pode assinar comandos (ACL)', (await assinar(`${PREFIXO}/command/#`)) === 128);
    verificar('app NAO pode assinar o estado de outro vaso (ACL)',
      (await assinar('naodenemagua/v1/vaso/vaso-02/state/vaso')) === 128);

    // Publicacoes proibidas: cada tentativa usa uma conexao propria, porque o
    // broker derruba quem publica onde nao pode.
    const publicarProibido = async (identidade, topico, payload) => {
      const c = (await tentarConectar(url, opcoesDe(identidade))).cliente;
      const caiu = new Promise((r) => c.once('close', () => r(true)));
      c.publish(topico, JSON.stringify(payload), { qos: 1 });
      const r = await Promise.race([caiu, esperar(3000).then(() => false)]);
      c.end(true);
      return r;
    };
    verificar('app tentando publicar COMANDO: broker nega e derruba a conexao',
      await publicarProibido('app-vaso-01', T.comando, { deviceId: 'app-vaso-01', action: 'PULSO_IRRIGACAO' }) &&
        /PUBLISH_NEGADO.*app-vaso-01.*command\/irrigacao/.test(saidaBroker));

    let nReq = 0;
    const pedido = (extra) => ({
      schemaVersion: 1, eventType: 'SolicitacaoApp', requestId: `req-teste-${BOOT_ID}-${++nReq}`,
      deviceId: 'app-vaso-01', entityId: 'vaso-01', action: 'RECONHECER_FALHA',
      createdAt: new Date().toISOString(), ttlMs: 30000, ...(extra || {})
    });
    verificar('app NAO fala em nome de outro: deviceId falsificado no pedido -> broker nega',
      await publicarProibido('app-vaso-01', TA.solicitacao, pedido({ deviceId: 'sim-vaso-01' })) &&
        /deviceId do payload \(sim-vaso-01\) != identidade \(app-vaso-01\)/.test(saidaBroker));
    verificar('gateway NAO pode fazer pedido de app (ACL)',
      await publicarProibido('sim-vaso-01', TA.solicitacao, pedido({ deviceId: 'sim-vaso-01' })));

    const solicitar = async (p) => {
      const antes = respostas.filter((x) => x.requestId === p.requestId).length;
      await new Promise((r) => app.publish(TA.solicitacao, JSON.stringify(p), { qos: 1 }, r));
      await aguardar(() => respostas.filter((x) => x.requestId === p.requestId).length > antes, 3000);
      return respostas.filter((x) => x.requestId === p.requestId).pop() || null;
    };
    const ultimoEstado = () => (estados.length ? estados[estados.length - 1].p : null);

    // Sem falha pendente: pedido valido, nada a fazer.
    await aguardar(() => ultimoEstado() && ultimoEstado().falhaPendente === false, 10000);
    let r = await solicitar(pedido());
    verificar('sem falha pendente: NADA_A_RECONHECER', r && r.result === 'NADA_A_RECONHECER', r && r.result);

    r = await solicitar(pedido({ createdAt: new Date(Date.now() - 60000).toISOString() }));
    verificar('pedido velho (createdAt + ttl ja passou): REJEITADA_EXPIRADA', r && r.result === 'REJEITADA_EXPIRADA', r && r.result);
    r = await solicitar(pedido({ createdAt: new Date(Date.now() + 120000).toISOString() }));
    verificar('relogio do celular adiantado demais: REJEITADA_EXPIRADA', r && r.result === 'REJEITADA_EXPIRADA', r && r.result);
    r = await solicitar(pedido({ action: 'LIGAR_BOMBA' }));
    verificar('acao fora do contrato (LIGAR_BOMBA): REJEITADA_CONTRATO, sem atuar', r && r.result === 'REJEITADA_CONTRATO', r && r.result);

    // Falha real: bomba sem fluxo -> FALHA_IRRIGACAO -> irrigacao bloqueada.
    const m = Date.now();
    sim('fs');
    const falhou = await aguardar(() => alertasDesde(m, 'FALHA_IRRIGACAO').length >= 1, 20000);
    const emAlerta = Date.now();
    verificar('bomba sem fluxo de novo: alerta FALHA_IRRIGACAO chega ao app', falhou);
    verificar('estado retido mostra falhaPendente (IRRIGACAO) e irrigacao bloqueada',
      await aguardar(() => ultimoEstado() && ultimoEstado().falhaPendente === true && ultimoEstado().irrigacao.bloqueada === true &&
        JSON.stringify(ultimoEstado().falhasPendentes) === '["IRRIGACAO"]', 3000),
      JSON.stringify(ultimoEstado() && { f: ultimoEstado().falhaPendente, i: ultimoEstado().irrigacao }));
    sim('f'); // o usuario "consertou" a bomba

    const mp = Date.now();
    const reconhecer = pedido();
    r = await solicitar(reconhecer);
    verificar('app reconhece a falha: EXECUTADA, irrigacao liberada',
      r && r.result === 'EXECUTADA' && r.liberou && r.liberou.irrigacao === true, r && JSON.stringify(r));
    const voltou = await aguardar(() => pulsos(mp).length >= 1, 5000);
    verificar('irrigacao volta logo apos o reconhecimento (antes do bloqueio vencer sozinho)',
      voltou && Date.now() - emAlerta < Number(AMBIENTE.VERIFICACAO_BLOQUEIO_MS), `${Date.now() - emAlerta}ms depois do alerta`);
    verificar('estado retido volta a falhaPendente=false',
      await aguardar(() => ultimoEstado() && ultimoEstado().falhaPendente === false, 3000));

    const pulsosAntes = pulsos(mp).length;
    r = await solicitar(reconhecer);
    verificar('retry do mesmo requestId: IGNORADA_DUPLICADA, com o resultado original',
      r && r.result === 'IGNORADA_DUPLICADA' && /EXECUTADA/.test(r.detail), r && JSON.stringify(r));
    await esperar(500);
    verificar('o retry nao repete o efeito', pulsos(mp).length === pulsosAntes);
    verificar('toda RespostaApp publicada respeita o contrato',
      respostas.length > 0 && respostas.every((x) => contrato.validar('RespostaApp', x).ok));
    sim('m');
    app.end(true);
  }

  // -------------------------------------------------------------------------
  console.log('20. Marco 4 -- R5: o app como produtor (sensor de luz do celular)');
  // -------------------------------------------------------------------------
  {
    const TL = `${PREFIXO}/telemetry/light`;
    const url = AMBIENTE.MQTT_URL;
    const app = (await tentarConectar(url, opcoesDe('app-vaso-01'))).cliente;
    conexoes.push(app);
    const estados = [];
    app.on('message', (t, b) => {
      try { if (t === `${PREFIXO}/state/vaso`) estados.push(JSON.parse(b.toString())); } catch { /* ignora */ }
    });
    await new Promise((r) => app.subscribe(`${PREFIXO}/state/vaso`, { qos: 1 }, r));
    const luzAtual = () => (estados.length ? estados[estados.length - 1].luz : null);

    const sessao = crypto.randomBytes(2).toString('hex');
    let seqLuz = 0;
    const leituraLuz = (lux, extra) => ({
      schemaVersion: 1, eventId: `app-vaso-01:${sessao}:${++seqLuz}`, eventType: 'LeituraLuz',
      deviceId: 'app-vaso-01', entityId: 'vaso-01', sequence: seqLuz, measuredAt: new Date().toISOString(),
      lux, samples: 3, windowMs: 500, sensor: 'teste', valid: true, ...(extra || {})
    });
    // A saida do servico tem cores ANSI entre o rotulo e a mensagem.
    const saidaSemCor = (desde) => saidaServico.slice(desde).replace(/\x1b\[[0-9;]*m/g, '');
    const publicarLuz = (p) => new Promise((r) => app.publish(TL, JSON.stringify(p), { qos: 1 }, r));
    // Publica a mesma luz a cada 500 ms por `ms` milissegundos.
    const manter = async (lux, ms) => {
      const fim = Date.now() + ms;
      while (Date.now() < fim) { await publicarLuz(leituraLuz(lux)); await esperar(500); }
    };

    await manter(2000, 1500);
    verificar('leituras do celular chegam ao servico: luz ADEQUADA no estado retido',
      await aguardar(() => luzAtual() && luzAtual().estado === 'ADEQUADA' && luzAtual().luxMedia === 2000, 4000),
      JSON.stringify(luzAtual()));

    // Mao sobre o sensor por ~1,5 s: menos que o tempo minimo (3 s).
    const m1 = Date.now();
    await manter(5, 1500);
    await manter(2000, 4000);
    verificar('sombra momentanea (menor que o tempo minimo) NAO gera alerta',
      alertasDesde(m1, 'LUZ_INSUFICIENTE').length === 0 && luzAtual().estado === 'ADEQUADA');

    const m2 = Date.now();
    await manter(5, 5000);
    verificar('pouca luz SUSTENTADA: LUZ_INSUFICIENTE e estado POUCA_LUZ',
      await aguardar(() => alertasDesde(m2, 'LUZ_INSUFICIENTE').length === 1, 3000) &&
        await aguardar(() => luzAtual() && luzAtual().estado === 'POUCA_LUZ', 3000));

    const m3 = Date.now();
    await manter(2000, 5000);
    verificar('luz volta e se mantem: LUZ_NORMALIZADA',
      await aguardar(() => alertasDesde(m3, 'LUZ_NORMALIZADA').length === 1, 3000));

    const m4 = Date.now();
    await manter(60000, 5000);
    verificar('sol direto sustentado: LUZ_EXCESSIVA',
      await aguardar(() => alertasDesde(m4, 'LUZ_EXCESSIVA').length === 1, 3000));

    const antesInvalida = saidaServico.length;
    await publicarLuz(leituraLuz(-5));
    await esperar(400);
    verificar('lux fora da faixa fisica (-5): rejeitado pelo contrato, servico vivo',
      /LeituraLuz SCHEMA_INVALIDO/.test(saidaServico.slice(antesInvalida)));

    const antesAtrasada = saidaServico.length;
    await publicarLuz(leituraLuz(5, { measuredAt: new Date(Date.now() - 60000).toISOString() }));
    await esperar(400);
    verificar('leitura medida ha 60 s (atrasada): arquivada como historico, nao decide',
      /HISTORICO\s+LeituraLuz .* chegou \d+ms depois de medida/.test(saidaSemCor(antesAtrasada)));

    const repetida = leituraLuz(60000);
    await publicarLuz(repetida);
    const antesDup = saidaServico.length;
    await publicarLuz(repetida);
    await esperar(400);
    verificar('a mesma LeituraLuz duas vezes (QoS 1): a segunda e descartada',
      new RegExp(`DUPLICADO\\s+${repetida.eventId}`).test(saidaSemCor(antesDup)));

    verificar('celular para de medir: depois da validade, SEM_MEDICAO',
      await aguardar(() => luzAtual() && luzAtual().estado === 'SEM_MEDICAO', Number(AMBIENTE.LUZ_VALIDADE_MS) + 4000),
      JSON.stringify(luzAtual()));

    // So o papel app publica luz: o gateway, nao.
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    const caiu = new Promise((r) => g.once('close', () => r(true)));
    g.publish(TL, JSON.stringify(leituraLuz(1000, { deviceId: 'sim-vaso-01' })), { qos: 1 });
    verificar('gateway NAO publica LeituraLuz (ACL): broker derruba',
      await Promise.race([caiu, esperar(3000).then(() => false)]));
    g.end(true);
    app.end(true);
  }
  olho.end(true);
}

process.on('exit', encerrarTudo);
// Evita deixar subprocessos e sockets abertos se uma conexão nunca completar.
setTimeout(() => {
  console.error('Tempo limite do teste excedido');
  encerrarTudo();
  process.exit(1);
}, 400000).unref();
process.on('uncaughtException', e => { console.error(e); encerrarTudo(); process.exit(1); });
process.on('SIGINT', () => {
  encerrarTudo();
  process.exit(130);
});

main().catch((e) => {
  console.error('erro no teste:', e);
  encerrarTudo();
  process.exit(1);
});

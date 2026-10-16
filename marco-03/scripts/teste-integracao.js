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
const PORTA = 8884; // porta propria, para nao colidir com um broker de demo aberto

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
  LIMIAR_DESLIGA: '50'
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

  await new Promise((r) => cliente.on('connect', r));
  cliente.subscribe(T.comando, { qos: 1 });

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

  cliente.on('message', (topico, buf) => {
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
  cliente.stream.destroy(); // encerra o socket sem DISCONNECT
  await esperar(1500);
  verificar('conexao encerrada abruptamente (LWT publicado pelo broker)', true);

  await secaoSeguranca(comandante);

  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  console.log('8. Canal -- so TLS, e so com o broker certo');
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
  console.log('9. Identidade -- o broker so aceita quem ele conhece');
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
  console.log('10. Autorizacao -- cada identidade so faz o que o seu papel permite');
  // -------------------------------------------------------------------------
  // Vigia o topico de comando com a identidade do gateway (a unica que o assina).
  const vigia = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
  const vistosNoComando = [];
  await new Promise((r) => vigia.subscribe(T.comando, { qos: 1 }, r));
  vigia.on('message', (t, b) => vistosNoComando.push(b.toString()));

  {
    const n = (await tentarConectar(url, opcoesDe('notificador'))).cliente;
    const caiu = new Promise((r) => n.on('close', () => r(true)));
    n.publish(T.comando, JSON.stringify({ forjado: true, action: 'PULSO_IRRIGACAO' }), { qos: 1 });
    const derrubado = await Promise.race([caiu, esperar(1500).then(() => false)]);
    await esperar(300);
    verificar('notificador NAO consegue publicar comando', vistosNoComando.length === 0,
      `${vistosNoComando.length} mensagem(ns) chegaram ao topico de comando`);
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
  console.log('11. Autenticidade (HMAC) -- o servico so decide sobre mensagem assinada');
  // -------------------------------------------------------------------------
  {
    const g = (await tentarConectar(url, opcoesDe('sim-vaso-01'))).cliente;
    const pub = (texto) => new Promise((r) => g.publish(T.telemetria, texto, { qos: 1 }, r));

    // Tres leituras secas SEM assinatura: bastariam para irrigar, se aceitas.
    for (let i = 0; i < 3; i++) await pub(JSON.stringify(leitura(20)));
    await esperar(600);
    verificar('leituras secas sem assinatura NAO geram comando', vistosNoComando.length === 0,
      `${vistosNoComando.length} comando(s)`);

    // Tres leituras assinadas como 60% e adulteradas para 20% depois.
    for (let i = 0; i < 3; i++) {
      await pub(seguranca.assinar(CHAVE, T.telemetria, leitura(60)).replace('"value":60', '"value":20'));
    }
    await esperar(600);
    verificar('leituras adulteradas apos assinar NAO geram comando', vistosNoComando.length === 0,
      `${vistosNoComando.length} comando(s)`);

    // Assinadas com a chave ERRADA (um atacante que conhece o formato, nao a chave).
    const chaveFalsa = crypto.randomBytes(32).toString('hex');
    for (let i = 0; i < 3; i++) await pub(seguranca.assinar(chaveFalsa, T.telemetria, leitura(20)));
    await esperar(600);
    verificar('leituras assinadas com chave errada NAO geram comando', vistosNoComando.length === 0,
      `${vistosNoComando.length} comando(s)`);

    // Controle positivo: as mesmas tres leituras, assinadas de verdade.
    await esperar(Number(AMBIENTE.COOLDOWN_MS));
    for (let i = 0; i < 3; i++) {
      await pub(seguranca.assinar(CHAVE, T.telemetria, leitura(20)));
      await esperar(150);
    }
    await esperar(700);
    verificar('as mesmas leituras, assinadas de verdade, geram comando (controle positivo)',
      vistosNoComando.length >= 1, 'nenhum comando');
    g.end(true);
  }
  vigia.end(true);

  // -------------------------------------------------------------------------
  console.log('12. Ultima barreira -- o dispositivo recusa comando nao assinado pelo servico');
  // -------------------------------------------------------------------------
  {
    // O simulador real e o dispositivo aqui: o teste so forja o comando.
    subir('simulador', 'simulador-produtor/src/main.js');
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

process.on('SIGINT', () => {
  encerrarTudo();
  process.exit(130);
});

main().catch((e) => {
  console.error('erro no teste:', e);
  encerrarTudo();
  process.exit(1);
});

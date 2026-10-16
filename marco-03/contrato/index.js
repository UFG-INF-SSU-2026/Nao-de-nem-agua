'use strict';
/*
 * Contrato compartilhado do Marco 2.
 *
 * Este modulo e deliberadamente o UNICO ponto em que produtor e consumidor se
 * encontram no codigo: ele carrega os schemas de contrato/v1, monta os nomes de
 * topico e concentra a politica de versao. Qualquer outro acoplamento entre os
 * dois componentes e acidental e deve ser removido.
 */

const fs = require('fs');
const path = require('path');
// Os schemas declaram o dialeto 2020-12; o export padrao do ajv implementa
// draft-07 e recusaria o proprio $schema. Este e o build do dialeto correto.
const Ajv = require('ajv/dist/2020');
const mqtt = require('mqtt');
const seguranca = require('../seguranca');

const RAIZ = path.resolve(__dirname, '..');
const VERSAO_SUPORTADA = 1;

// ---------------------------------------------------------------------------
// Configuracao: arquivo + sobrescrita por variavel de ambiente
// ---------------------------------------------------------------------------

function carregarConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));

  // A sobrescrita por ambiente existe para a "pequena alteracao durante a
  // verificacao": trocar de broker ou de limiar sem editar arquivo nenhum.
  const env = process.env;
  if (env.MQTT_URL) cfg.mqtt.url = env.MQTT_URL;
  if (env.BROKER_PORT) cfg.mqtt.brokerPort = Number(env.BROKER_PORT);
  if (env.TOPIC_PREFIX) cfg.identidade.prefixoTopico = env.TOPIC_PREFIX;
  if (env.VASO_ID) cfg.identidade.vasoId = env.VASO_ID;

  const mapaRegra = {
    LIMIAR_LIGA: 'limiarLiga',
    LIMIAR_DESLIGA: 'limiarDesliga',
    AMOSTRAS_DEBOUNCE: 'amostrasDebounce',
    COOLDOWN_MS: 'cooldownMs',
    VALIDADE_MS: 'validadeMs',
    DURACAO_PULSO_MS: 'duracaoPulsoMs',
    COMANDO_TTL_MS: 'comandoTtlMs'
  };
  for (const [chaveEnv, chaveCfg] of Object.entries(mapaRegra)) {
    if (env[chaveEnv] !== undefined) cfg.regra[chaveCfg] = Number(env[chaveEnv]);
  }

  if (env.EXIGIR_ASSINATURA !== undefined) {
    cfg.seguranca.exigirAssinatura = env.EXIGIR_ASSINATURA !== '0';
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Conexao segura
// ---------------------------------------------------------------------------

const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function brokerLocal(url) {
  return HOSTS_LOCAIS.has(new URL(url).hostname);
}

/*
 * Ponto UNICO de conexao ao broker, usado por todos os componentes Node.
 *
 * Broker local (caminho A): TLS com a CA propria + usuario/senha da identidade.
 * Broker publico (caminho B): TLS com as CAs do sistema e SEM credenciais --
 * enviar a nossa senha a um broker de terceiros seria entrega-la. Nesse caminho
 * quem autentica e o HMAC de cada mensagem.
 *
 * rejectUnauthorized fica sempre ligado: um cliente que aceita qualquer
 * certificado tem um canal cifrado com um interlocutor desconhecido, o que nao
 * e um canal seguro.
 */
function conectar(cfg, identidade, opcoes) {
  const url = cfg.mqtt.url;
  const local = brokerLocal(url);
  const final = {
    reconnectPeriod: 2000,
    connectTimeout: 8000,
    rejectUnauthorized: true,
    ...(opcoes || {})
  };
  if (url.startsWith('mqtts:') && local) final.ca = seguranca.caPropria();
  if (local) {
    final.username = identidade;
    final.password = seguranca.senhaDe(identidade);
  }
  return mqtt.connect(url, final);
}

// ---------------------------------------------------------------------------
// Topicos
// ---------------------------------------------------------------------------

function topicos(cfg) {
  const base = `${cfg.identidade.prefixoTopico}/vaso/${cfg.identidade.vasoId}`;
  return {
    base,
    telemetriaSolo: `${base}/telemetry/soil`,
    heartbeat: `${base}/status/heartbeat`,
    comandoIrrigacao: `${base}/command/irrigacao`,
    ackIrrigacao: `${base}/ack/irrigacao`,
    // Curinga usado pelo servico: um assinante novo (por exemplo o app Android
    // previsto como evolucao) assina exatamente o mesmo padrao, sem que
    // produtor ou servico precisem mudar.
    todosOsVasos: `${cfg.identidade.prefixoTopico}/vaso/+`
  };
}

// ---------------------------------------------------------------------------
// Validacao de contrato
// ---------------------------------------------------------------------------

const ARQUIVOS_SCHEMA = {
  LeituraUmidadeSolo: 'telemetria-solo.schema.json',
  EstadoConectividade: 'estado-conectividade.schema.json',
  ComandoIrrigacao: 'comando-irrigacao.schema.json',
  ConfirmacaoAtuacao: 'confirmacao-atuacao.schema.json'
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validadores = {};

for (const [tipo, arquivo] of Object.entries(ARQUIVOS_SCHEMA)) {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'v1', arquivo), 'utf8')
  );
  validadores[tipo] = ajv.compile(schema);
}

/*
 * Valida um payload ja desserializado.
 *
 * Devolve sempre um objeto com { ok, motivo, detalhe } em vez de lancar
 * excecao: um payload malformado de um produtor qualquer NAO deve derrubar o
 * consumidor. Essa e a diferenca entre rejeitar um evento e perder o servico.
 */
function validar(tipoEsperado, payload) {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, motivo: 'PAYLOAD_NAO_OBJETO' };
  }

  // A versao e verificada ANTES do schema. Um produtor mais novo publicando
  // schemaVersion 2 deve receber uma rejeicao clara e especifica, e nao uma
  // lista de campos desconhecidos.
  if (payload.schemaVersion !== VERSAO_SUPORTADA) {
    return {
      ok: false,
      motivo: 'VERSAO_NAO_SUPORTADA',
      detalhe: `recebido schemaVersion=${JSON.stringify(payload.schemaVersion)}, suportado=${VERSAO_SUPORTADA}`
    };
  }

  const validador = validadores[tipoEsperado];
  if (!validador) {
    return { ok: false, motivo: 'TIPO_DESCONHECIDO', detalhe: tipoEsperado };
  }

  if (!validador(payload)) {
    const erros = (validador.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    return { ok: false, motivo: 'SCHEMA_INVALIDO', detalhe: erros };
  }

  return { ok: true };
}

/* Desserializacao tolerante: JSON quebrado tambem e uma condicao de falha. */
function desserializar(buffer) {
  try {
    return { ok: true, payload: JSON.parse(buffer.toString('utf8')) };
  } catch (e) {
    return { ok: false, motivo: 'JSON_MALFORMADO', detalhe: e.message };
  }
}

/*
 * Desserializa E autentica uma mensagem de dispositivo.
 *
 * Ordem: JSON -> dispositivo conhecido -> vaso do topico -> assinatura. A
 * autenticidade e conferida ANTES do schema: nao faz sentido gastar validacao
 * de conteudo com uma mensagem cuja origem nao se sabe.
 */
function abrirMensagemDeDispositivo(cfg, topico, buffer) {
  const texto = buffer.toString('utf8');
  const bruto = desserializar(buffer);
  if (!bruto.ok) return bruto;

  const payload = bruto.payload;
  if (!cfg.seguranca.exigirAssinatura) return { ok: true, payload };

  const disp = payload && dispositivoDe(payload.deviceId);
  if (!disp) {
    return { ok: false, motivo: 'DISPOSITIVO_DESCONHECIDO', detalhe: `deviceId=${payload && payload.deviceId}` };
  }
  if (!topico.includes(`/vaso/${disp.vasoId}/`)) {
    return { ok: false, motivo: 'VASO_NAO_PERTENCE_AO_DISPOSITIVO', detalhe: `${payload.deviceId} nao e do vaso deste topico` };
  }
  const sig = seguranca.verificarAssinatura(disp.chave, topico, texto);
  if (!sig.ok) return { ok: false, motivo: sig.motivo, detalhe: sig.detalhe || `deviceId=${payload.deviceId}` };

  return { ok: true, payload };
}

function dispositivoDe(deviceId) {
  return typeof deviceId === 'string' ? seguranca.dispositivo(deviceId) : null;
}

module.exports = {
  VERSAO_SUPORTADA,
  carregarConfig,
  topicos,
  validar,
  desserializar,
  conectar,
  brokerLocal,
  abrirMensagemDeDispositivo
};

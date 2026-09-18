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

  return cfg;
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

module.exports = {
  VERSAO_SUPORTADA,
  carregarConfig,
  topicos,
  validar,
  desserializar
};

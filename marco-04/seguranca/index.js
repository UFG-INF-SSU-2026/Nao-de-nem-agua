'use strict';
/*
 * Seguranca do Marco 3 -- as tres camadas pedidas, num modulo so.
 *
 *   1. CANAL        TLS com CA propria (caminho A) ou CA publica (caminho B).
 *   2. IDENTIDADE   usuario/senha por componente, conferidos pelo broker contra
 *                   hashes scrypt (caminho A); assinatura HMAC por dispositivo
 *                   em cada mensagem (caminhos A e B).
 *   3. AUTORIZACAO  ACL por papel, amarrada ao vaso, aplicada pelo broker a cada
 *                   PUBLISH e SUBSCRIBE (caminho A).
 *
 * Por que existem DUAS formas de autenticacao. A senha autentica a CONEXAO com
 * um broker em que confiamos. O HMAC autentica a MENSAGEM, e continua valendo
 * quando o broker nao e confiavel -- que e o caso do broker publico do caminho B,
 * onde qualquer pessoa na internet pode publicar no nosso topico de comando.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { gerar, ARQUIVOS } = require('./gerar');

const DIR = __dirname;

function lerJson(arquivo) {
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

// ---------------------------------------------------------------------------
// Material gerado (certificados e senhas)
// ---------------------------------------------------------------------------

/* Garante que certificados e credenciais existam, gerando-os na primeira execucao. */
function garantirMaterial() {
  return gerar({ forcar: false });
}

function certificadosBroker() {
  garantirMaterial();
  return {
    key: fs.readFileSync(ARQUIVOS.brokerKey),
    cert: fs.readFileSync(ARQUIVOS.brokerCrt)
  };
}

function caPropria() {
  garantirMaterial();
  return fs.readFileSync(ARQUIVOS.caCrt);
}

/* Senha em claro de uma identidade -- lida pelo CLIENTE que a usa. */
function senhaDe(identidade) {
  garantirMaterial();
  const segredos = lerJson(ARQUIVOS.segredos);
  if (!segredos[identidade]) {
    throw new Error(`identidade sem senha provisionada: ${identidade} (rode \`npm run seguranca -- --forcar\`)`);
  }
  return segredos[identidade];
}

// ---------------------------------------------------------------------------
// Autenticacao no broker
// ---------------------------------------------------------------------------

let credenciaisCache = null;

/*
 * Confere usuario/senha contra o hash guardado. A comparacao e feita em tempo
 * constante (timingSafeEqual): uma comparacao comum termina no primeiro byte
 * diferente, e o tempo de resposta vazaria quantos bytes estavam certos.
 */
function verificarSenha(usuario, senha) {
  if (!credenciaisCache) {
    garantirMaterial();
    credenciaisCache = lerJson(ARQUIVOS.credenciais);
  }
  const registro = credenciaisCache[usuario];
  if (!registro || typeof senha !== 'string') return false;

  const calculado = crypto.scryptSync(senha, Buffer.from(registro.sal, 'hex'), registro.hash.length / 2, {
    N: registro.N,
    r: registro.r,
    p: registro.p
  });
  return crypto.timingSafeEqual(calculado, Buffer.from(registro.hash, 'hex'));
}

// ---------------------------------------------------------------------------
// Autorizacao (ACL)
// ---------------------------------------------------------------------------

/*
 * Carrega a politica e resolve {prefixo} e {vasoId} para cada identidade.
 * Devolve { identidade: { papel, deviceId, vasoId, publica[], assina[], verificarDeviceId } }.
 */
function carregarAcl(prefixo) {
  const acl = lerJson(path.join(DIR, 'acl.json'));
  const resolvida = {};
  for (const [nome, ident] of Object.entries(acl.identidades)) {
    const papel = acl.papeis[ident.papel];
    if (!papel) throw new Error(`papel desconhecido para ${nome}: ${ident.papel}`);
    const resolver = (filtro) =>
      filtro.replace('{prefixo}', prefixo).replace('{vasoId}', ident.vasoId || '__sem_vaso__');
    resolvida[nome] = {
      nome,
      papel: ident.papel,
      deviceId: ident.deviceId || null,
      vasoId: ident.vasoId || null,
      publica: papel.publica.map(resolver),
      assina: papel.assina.map(resolver),
      verificarDeviceId: Boolean(papel.verificarDeviceId)
    };
  }
  return resolvida;
}

/* Um topico concreto casa com um filtro MQTT (com + e #)? */
function topicoCasa(filtro, topico) {
  const f = filtro.split('/');
  const t = topico.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/*
 * O filtro pedido numa assinatura esta CONTIDO no filtro permitido?
 *
 * Nao basta casar como topico: assinar `vaso/+/command/#` e pedir os comandos de
 * TODOS os vasos, e isso so pode ser concedido se a ACL permitir algo tao amplo
 * quanto. Um curinga pedido so e coberto por um curinga igual ou mais amplo.
 */
function filtroCobre(permitido, pedido) {
  const a = permitido.split('/');
  const b = pedido.split('/');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '#') return true;
    if (i >= b.length) return false;
    if (b[i] === '#') return false;
    if (a[i] === '+') continue;
    if (b[i] === '+' || a[i] !== b[i]) return false;
  }
  return a.length === b.length;
}

function podePublicar(ident, topico) {
  return Boolean(ident) && ident.publica.some((f) => topicoCasa(f, topico));
}

function podeAssinar(ident, filtro) {
  return Boolean(ident) && ident.assina.some((f) => filtroCobre(f, filtro));
}

// ---------------------------------------------------------------------------
// Assinatura de mensagem (HMAC-SHA256)
// ---------------------------------------------------------------------------

/*
 * Formato: a assinatura e SEMPRE o ultimo campo do JSON, `,"sig":"<64 hex>"}`.
 *
 * Assina-se o TEXTO exato do corpo (o JSON sem o campo sig), e nao o objeto. Se
 * a assinatura fosse sobre o objeto, os dois lados precisariam serializar de
 * forma identica -- e o ESP32 imprime 20.0 onde o JavaScript imprime 20. Com o
 * texto exato, o ESP32 assina os bytes que vai enviar e o servico confere os
 * bytes que recebeu, sem canonicalizacao.
 *
 * O topico entra na assinatura: uma mensagem legitima copiada para outro topico
 * (por exemplo, de outro vaso) deixa de ser valida.
 */
const SUFIXO_SIG = /,"sig":"([0-9a-f]{64})"\}$/;

let chavesCache = null;

function chaves() {
  if (!chavesCache) chavesCache = lerJson(path.join(DIR, 'chaves-hmac.json')).dispositivos;
  return chavesCache;
}

/* Chave e vaso de um dispositivo conhecido; null se o deviceId nao e reconhecido. */
function dispositivo(deviceId) {
  return chaves()[deviceId] || null;
}

function calcularHmac(chaveHex, topico, corpo) {
  return crypto
    .createHmac('sha256', Buffer.from(chaveHex, 'hex'))
    .update(`${topico}\n${corpo}`, 'utf8')
    .digest('hex');
}

/* Recebe o JSON do corpo (texto) e devolve o texto com o campo sig acrescentado. */
function assinarTexto(chaveHex, topico, corpo) {
  const sig = calcularHmac(chaveHex, topico, corpo);
  return `${corpo.slice(0, -1)},"sig":"${sig}"}`;
}

/* Atalho: serializa o objeto e assina. */
function assinar(chaveHex, topico, objeto) {
  return assinarTexto(chaveHex, topico, JSON.stringify(objeto));
}

/*
 * Confere a assinatura de uma mensagem recebida.
 * Devolve { ok, motivo, detalhe }. Nunca lanca: assinatura ruim e uma rejeicao,
 * nao uma queda do servico.
 */
function verificarAssinatura(chaveHex, topico, texto) {
  const m = SUFIXO_SIG.exec(texto);
  if (!m) return { ok: false, motivo: 'ASSINATURA_AUSENTE' };
  const corpo = texto.slice(0, m.index) + '}';
  const esperado = Buffer.from(calcularHmac(chaveHex, topico, corpo), 'hex');
  const recebido = Buffer.from(m[1], 'hex');
  if (!crypto.timingSafeEqual(esperado, recebido)) {
    return { ok: false, motivo: 'ASSINATURA_INVALIDA', detalhe: 'HMAC nao confere com a chave do dispositivo' };
  }
  return { ok: true };
}

module.exports = {
  garantirMaterial,
  certificadosBroker,
  caPropria,
  senhaDe,
  verificarSenha,
  carregarAcl,
  topicoCasa,
  filtroCobre,
  podePublicar,
  podeAssinar,
  dispositivo,
  assinar,
  assinarTexto,
  verificarAssinatura
};

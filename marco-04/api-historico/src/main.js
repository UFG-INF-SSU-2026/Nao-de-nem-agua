'use strict';
/*
 * api-historico -- Marco 4. O historico do vaso para o app, a partir do
 * TimescaleDB.
 *
 * Por que uma API, e nao o app no banco: o banco so escuta em 127.0.0.1 e as
 * credenciais dele sao administrativas para o app (o PDF pede credenciais
 * administrativas fora do aplicativo). A API fica entre os dois:
 *
 *   canal         HTTPS (TLS 1.2+) com certificado PROPRIO, da CA do grupo
 *   identidade    usuario/senha da identidade do app (mesmos hashes do broker)
 *   autorizacao   so papel `app`, so o proprio vaso (ver autenticacao.js)
 *   banco         papel leitor_app: SELECT e mais nada. Mesmo com a API
 *                 comprometida, o historico nao pode ser alterado por ela.
 *
 * Rotas (todas GET; o resto e 405):
 *   /v1/saude                                    sem dados, sem autenticacao
 *   /v1/vasos/{vasoId}/historico?horas=24        HistoricoVaso
 *   /v1/vasos/{vasoId}/alertas?horas=168&limite=50  HistoricoAlertas
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { Pool } = require('pg');
const contrato = require('../../contrato');
const seguranca = require('../../seguranca');
const { ARQUIVOS_API, garantirCertificadoApi } = require('../../seguranca/gerar');
const { lerBasic, autorizar, LimiteTentativas } = require('./autenticacao');
const consultas = require('./consultas');

const RAIZ = path.resolve(__dirname, '../..');
const cfg = contrato.carregarConfig();
const PORTA = Number(process.env.API_PORTA || cfg.api.porta);
const acl = seguranca.carregarAcl(cfg.identidade.prefixoTopico);
const limite = new LimiteTentativas(cfg.api.tentativasMax, cfg.api.janelaTentativasMs);

function hora() {
  return new Date().toISOString().slice(11, 23);
}
function log(evento, detalhe) {
  console.log(`[${hora()}] api     ${evento.padEnd(16)} ${detalhe || ''}`);
}

/* Senha do leitor_app: variavel de ambiente ou o .env gerado por `npm run seguranca`. */
function senhaLeitor() {
  if (process.env.PERSISTENCIA_SENHA_LEITOR) return process.env.PERSISTENCIA_SENHA_LEITOR;
  const arquivo = path.join(RAIZ, '.env');
  if (!fs.existsSync(arquivo)) throw new Error('sem .env: rode `npm run seguranca`');
  return util.parseEnv(fs.readFileSync(arquivo, 'utf8')).PERSISTENCIA_SENHA_LEITOR;
}

const pool = new Pool({
  host: cfg.persistencia.host,
  port: cfg.persistencia.porta,
  database: cfg.persistencia.banco,
  user: 'leitor_app',
  password: senhaLeitor(),
  max: 4,
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
  application_name: 'api-historico'
});
// Banco caiu com conexao ociosa no pool: registra e segue (a proxima consulta responde 503).
pool.on('error', (e) => log('BANCO', `conexao perdida: ${e.message}`));
const q = async (sql, params) => (await pool.query(sql, params)).rows;

function responder(res, status, corpo, cabecalhos) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(cabecalhos || {})
  });
  res.end(texto);
}

const erro = (res, status, codigo, mensagem, cabecalhos) =>
  responder(res, status, { erro: codigo, mensagem }, cabecalhos);

async function tratar(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'https://api');
  const inicio = Date.now();
  const fim = (status, extra) => log(String(status), `${req.method} ${url.pathname}${url.search} ${ip}${extra ? ` -- ${extra}` : ''} (${Date.now() - inicio} ms)`);

  if (req.method !== 'GET') {
    erro(res, 405, 'METODO_NAO_PERMITIDO', 'API somente leitura: so GET.', { Allow: 'GET' });
    return fim(405);
  }

  if (url.pathname === '/v1/saude') {
    let banco = true;
    try { await q('SELECT 1'); } catch { banco = false; }
    responder(res, banco ? 200 : 503, { status: banco ? 'ok' : 'banco_indisponivel' });
    return fim(banco ? 200 : 503);
  }

  const rota = /^\/v1\/vasos\/([^/]+)\/(historico|alertas)$/.exec(url.pathname);
  if (!rota) {
    erro(res, 404, 'NAO_ENCONTRADO', 'Rota desconhecida.');
    return fim(404);
  }

  // --- identidade ------------------------------------------------------------
  const agora = Date.now();
  if (limite.bloqueado(ip, agora)) {
    const espera = limite.esperaS(ip, agora);
    erro(res, 429, 'MUITAS_TENTATIVAS', `Muitas senhas erradas. Tente em ${espera} s.`, { 'Retry-After': String(espera) });
    return fim(429, 'bloqueado por tentativas');
  }
  const cred = lerBasic(req.headers.authorization);
  if (!cred || !acl[cred.usuario] || !seguranca.verificarSenha(cred.usuario, cred.senha)) {
    // Mesma resposta para usuario inexistente e senha errada (nao revela quem existe).
    if (cred) limite.falhou(ip, agora);
    erro(res, 401, 'NAO_AUTENTICADO', 'Usuario ou senha invalidos.', { 'WWW-Authenticate': 'Basic realm="naodenemagua", charset="UTF-8"' });
    return fim(401, cred ? `usuario=${cred.usuario}` : 'sem credenciais');
  }
  limite.acertou(ip);

  // --- parametros e autorizacao ------------------------------------------------
  const tipo = rota[2];
  let vasoPedido;
  try { vasoPedido = decodeURIComponent(rota[1]); } catch { vasoPedido = ''; }
  const p = consultas.parametros(cfg.api, vasoPedido, url.searchParams, tipo === 'historico' ? 24 : 168);
  if (!p.ok) {
    erro(res, 400, 'PARAMETRO_INVALIDO', p.motivo);
    return fim(400, p.motivo);
  }
  const autz = autorizar(acl[cred.usuario], p.valores.vasoId);
  if (!autz.ok) {
    erro(res, 403, 'NAO_AUTORIZADO', autz.motivo);
    return fim(403, autz.motivo);
  }

  // --- consulta ---------------------------------------------------------------------
  let corpo;
  try {
    corpo = tipo === 'historico' ? await consultas.historico(q, p.valores) : await consultas.alertas(q, p.valores);
  } catch (e) {
    erro(res, 503, 'BANCO_INDISPONIVEL', 'Historico indisponivel no momento.');
    return fim(503, e.message);
  }
  // Produzir fora do contrato e tao grave quanto consumir fora dele.
  const valido = contrato.validar(tipo === 'historico' ? 'HistoricoVaso' : 'HistoricoAlertas', corpo);
  if (!valido.ok) {
    erro(res, 500, 'ERRO_INTERNO', 'Resposta gerada fora do contrato.');
    return fim(500, valido.detalhe);
  }
  responder(res, 200, corpo);
  return fim(200, cred.usuario);
}

// ---------------------------------------------------------------------------
// TLS e partida
// ---------------------------------------------------------------------------

seguranca.garantirMaterial();
garantirCertificadoApi([], false);

const servidor = https.createServer({
  key: fs.readFileSync(ARQUIVOS_API.key),
  cert: fs.readFileSync(ARQUIVOS_API.crt),
  minVersion: 'TLSv1.2'
}, (req, res) => {
  tratar(req, res).catch((e) => {
    log('500', e.stack || e.message);
    if (!res.headersSent) erro(res, 500, 'ERRO_INTERNO', 'Falha inesperada.');
  });
});

servidor.on('tlsClientError', (e, socket) => log('TLS_RECUSADO', `${socket.remoteAddress || '?'}: ${e.code || e.message}`));

servidor.listen(PORTA, () => {
  log('OUVINDO', `https://localhost:${PORTA} (TLS obrigatorio, CA do grupo)`);
  console.log('');
  console.log(`  Banco ${cfg.persistencia.banco} como leitor_app (somente SELECT).`);
  console.log('  Rotas: /v1/saude, /v1/vasos/{vasoId}/historico?horas=N, /v1/vasos/{vasoId}/alertas?horas=N&limite=M');
  console.log('  Pelo cabo USB, no celular: adb reverse tcp:8443 tcp:8443');
  console.log('');
});

function encerrar() {
  log('ENCERRANDO', '');
  servidor.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

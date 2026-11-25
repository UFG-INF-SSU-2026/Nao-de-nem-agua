'use strict';
/*
 * Gera o material de seguranca do caminho A -- `npm run seguranca`.
 *
 *   certs/ca.crt, certs/ca.key          autoridade certificadora PROPRIA do grupo
 *   certs/broker.crt, certs/broker.key  certificado do broker, assinado pela CA,
 *                                       valido para localhost e 127.0.0.1 (+ os
 *                                       hosts de --broker-host, Marco 4)
 *   credenciais.json                    o que o BROKER guarda: hash scrypt + sal
 *                                       de cada identidade, nunca a senha
 *   segredos.json                       o que cada CLIENTE guarda: a propria senha
 *                                       (equivale ao provisionamento do dispositivo)
 *
 * Nada disso e versionado (ver .gitignore): cada maquina gera o seu. A chave
 * privada da CA e as senhas sao segredos -- publica-los no repositorio anularia
 * exatamente o que este marco demonstra.
 *
 * Por que uma CA propria e nao um certificado autoassinado direto no broker: o
 * cliente passa a confiar na CA, nao num certificado especifico. E o mesmo
 * modelo da internet (o navegador confia em CAs), em escala de bancada.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const DIR = __dirname;
const CERTS = path.join(DIR, 'certs');

const ARQUIVOS = {
  caCrt: path.join(CERTS, 'ca.crt'),
  caKey: path.join(CERTS, 'ca.key'),
  brokerCrt: path.join(CERTS, 'broker.crt'),
  brokerKey: path.join(CERTS, 'broker.key'),
  credenciais: path.join(DIR, 'credenciais.json'),
  segredos: path.join(DIR, 'segredos.json')
};

/*
 * Marco 4: certificado da API de historico (api-historico/). Fica FORA de
 * ARQUIVOS de proposito: faltar so ele nao pode disparar a regeneracao de tudo
 * (CA e senhas novas quebrariam o app ja instalado). E emitido sozinho, pela CA
 * que ja existe -- ver garantirCertificadoApi().
 */
const ARQUIVOS_API = {
  crt: path.join(CERTS, 'api.crt'),
  key: path.join(CERTS, 'api.key')
};

/* Parametros do scrypt. Lento de proposito: dificulta forca bruta se o arquivo vazar. */
const SCRYPT = { N: 16384, r: 8, p: 1, tamanho: 32 };

function hashSenha(senha, salHex) {
  const sal = salHex ? Buffer.from(salHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, SCRYPT.tamanho, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });
  return { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, sal: sal.toString('hex'), hash: hash.toString('hex') };
}

function parDeChaves() {
  // A geracao RSA do node-forge e JavaScript puro e lenta; a do Node e nativa.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const priv = forge.pki.privateKeyFromPem(pem);
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  return { priv, pub, pem };
}

function serial() {
  // Serial positivo de 16 bytes (bit mais alto zerado).
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

function validadeDoisAnos() {
  const agora = new Date();
  const validade = new Date(agora);
  validade.setFullYear(validade.getFullYear() + 2);
  return { agora, validade };
}

/*
 * Marco 4: o app Android fala com o broker a partir do celular. Pelo cabo USB
 * (`adb reverse tcp:8883 tcp:8883`) ele usa localhost e o certificado de
 * sempre serve. Pela rede Wi-Fi ele usa o IP desta maquina, e o certificado
 * precisa nomear esse IP -- senao o app, que confere o nome do servidor, recusa
 * a conexao (e deve recusar). Cada item vira uma entrada do subjectAltName.
 */
function altNamesBroker(hostsExtras) {
  const nomes = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  for (const h of hostsExtras || []) {
    if (h === 'localhost' || h === '127.0.0.1') continue;
    nomes.push(/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h });
  }
  return nomes;
}

/*
 * Certificado de SERVIDOR assinado pela CA do grupo. Broker e API de historico
 * tem certificados (e chaves) separados: comprometer um nao entrega o outro.
 */
function emitirCertificadoBroker(caCert, caPriv, hostsExtras, destino) {
  const arquivos = destino || { crt: ARQUIVOS.brokerCrt, key: ARQUIVOS.brokerKey };
  const { agora, validade } = validadeDoisAnos();
  const broker = parDeChaves();
  const brokerCert = forge.pki.createCertificate();
  brokerCert.publicKey = broker.pub;
  brokerCert.serialNumber = serial();
  brokerCert.validity.notBefore = agora;
  brokerCert.validity.notAfter = validade;
  brokerCert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  brokerCert.setIssuer(caCert.subject.attributes);
  brokerCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      // O cliente confere o NOME do servidor contra esta lista. E isso que impede
      // um terceiro com outro certificado da mesma CA de se passar pelo broker.
      name: 'subjectAltName',
      altNames: altNamesBroker(hostsExtras)
    },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
  ]);
  brokerCert.sign(caPriv, forge.md.sha256.create());
  fs.writeFileSync(arquivos.crt, forge.pki.certificateToPem(brokerCert));
  fs.writeFileSync(arquivos.key, broker.pem, { mode: 0o600 });
}

function lerCa() {
  if (!fs.existsSync(ARQUIVOS.caCrt) || !fs.existsSync(ARQUIVOS.caKey)) {
    throw new Error('CA inexistente: rode `npm run seguranca` antes');
  }
  return {
    caCert: forge.pki.certificateFromPem(fs.readFileSync(ARQUIVOS.caCrt, 'utf8')),
    caPriv: forge.pki.privateKeyFromPem(fs.readFileSync(ARQUIVOS.caKey, 'utf8'))
  };
}

/* Emite o certificado da API se faltar (ou se houver hosts novos). Devolve true se emitiu. */
function garantirCertificadoApi(hostsExtras, forcar) {
  if (!forcar && fs.existsSync(ARQUIVOS_API.crt) && fs.existsSync(ARQUIVOS_API.key)) return false;
  const { caCert, caPriv } = lerCa();
  emitirCertificadoBroker(caCert, caPriv, hostsExtras, ARQUIVOS_API);
  return true;
}

/*
 * Reemite SO o certificado do broker, assinado pela CA que ja existe. A CA nao
 * muda -- entao o app (que confia na CA, nao no certificado) nao precisa ser
 * reinstalado, e as senhas continuam valendo.
 */
function reemitirCertificadoBroker(hostsExtras) {
  const { caCert, caPriv } = lerCa();
  emitirCertificadoBroker(caCert, caPriv, hostsExtras);
  // A API e acessada pelo mesmo endereco que o broker: mesmos nomes.
  emitirCertificadoBroker(caCert, caPriv, hostsExtras, ARQUIVOS_API);
  return altNamesBroker(hostsExtras).map((n) => n.ip || n.value);
}

function gerarCertificados(hostsExtras) {
  const { agora, validade } = validadeDoisAnos();

  // --- CA ---
  const ca = parDeChaves();
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = ca.pub;
  caCert.serialNumber = serial();
  caCert.validity.notBefore = agora;
  caCert.validity.notAfter = validade;
  const caNome = [
    { name: 'commonName', value: 'Nao de nem agua - CA de bancada' },
    { name: 'organizationName', value: 'UFG - Software para Sistemas Ubiquos' }
  ];
  caCert.setSubject(caNome);
  caCert.setIssuer(caNome);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  caCert.sign(ca.priv, forge.md.sha256.create());

  fs.mkdirSync(CERTS, { recursive: true });
  fs.writeFileSync(ARQUIVOS.caCrt, forge.pki.certificateToPem(caCert));
  fs.writeFileSync(ARQUIVOS.caKey, ca.pem, { mode: 0o600 });

  // --- Broker ---
  emitirCertificadoBroker(caCert, ca.priv, hostsExtras);
}

/*
 * Marco 4: identidade nova na ACL (por exemplo o app) sem invalidar as que ja
 * existem. Acrescenta senha so para quem nao tem; as demais ficam como estao.
 */
function completarCredenciais() {
  const acl = JSON.parse(fs.readFileSync(path.join(DIR, 'acl.json'), 'utf8'));
  const credenciais = JSON.parse(fs.readFileSync(ARQUIVOS.credenciais, 'utf8'));
  const segredos = JSON.parse(fs.readFileSync(ARQUIVOS.segredos, 'utf8'));
  const novas = Object.keys(acl.identidades).filter((id) => !segredos[id] || !credenciais[id]);
  for (const identidade of novas) {
    const senha = crypto.randomBytes(18).toString('base64url');
    segredos[identidade] = senha;
    credenciais[identidade] = hashSenha(senha);
  }
  if (novas.length) {
    fs.writeFileSync(ARQUIVOS.credenciais, JSON.stringify(credenciais, null, 2) + '\n');
    fs.writeFileSync(ARQUIVOS.segredos, JSON.stringify(segredos, null, 2) + '\n', { mode: 0o600 });
  }
  return novas;
}

function gerarCredenciais() {
  const acl = JSON.parse(fs.readFileSync(path.join(DIR, 'acl.json'), 'utf8'));
  const credenciais = {};
  const segredos = {};
  for (const identidade of Object.keys(acl.identidades)) {
    const senha = crypto.randomBytes(18).toString('base64url');
    segredos[identidade] = senha;
    credenciais[identidade] = hashSenha(senha);
  }
  fs.writeFileSync(ARQUIVOS.credenciais, JSON.stringify(credenciais, null, 2) + '\n');
  fs.writeFileSync(ARQUIVOS.segredos, JSON.stringify(segredos, null, 2) + '\n', { mode: 0o600 });
  return Object.keys(segredos);
}

function materialCompleto() {
  return Object.values(ARQUIVOS).every((f) => fs.existsSync(f));
}

/*
 * Marco 4: senhas do banco (TimescaleDB) no arquivo .env da raiz do marco, lido
 * pelo docker compose (que cria os papeis) e pelo servico (persistencia/).
 * Fica fora do Git. Nao e regenerado com --forcar: o volume do banco ja foi
 * criado com estas senhas, e troca-las exigiria recriar o volume
 * (`docker compose down -v`).
 */
const ARQUIVO_ENV = path.join(DIR, '..', '.env');
const CHAVES_ENV = ['POSTGRES_PASSWORD', 'PERSISTENCIA_SENHA_SERVICO', 'PERSISTENCIA_SENHA_LEITOR'];

function gerarEnvBanco() {
  const atual = fs.existsSync(ARQUIVO_ENV) ? fs.readFileSync(ARQUIVO_ENV, 'utf8') : '';
  const faltando = CHAVES_ENV.filter((k) => !new RegExp(`^${k}=`, 'm').test(atual));
  if (faltando.length === 0) return [];
  const linhas = faltando.map((k) => `${k}=${crypto.randomBytes(18).toString('base64url')}`);
  const prefixo = atual && !atual.endsWith('\n') ? '\n' : '';
  const cabecalho = atual ? '' : '# Gerado por `npm run seguranca`. Segredos: NAO versionar.\n';
  fs.writeFileSync(ARQUIVO_ENV, atual + prefixo + cabecalho + linhas.join('\n') + '\n', { mode: 0o600 });
  return faltando;
}

/* Gera o que faltar. Com forcar=true, regenera tudo (invalida senhas e certificados antigos). */
function gerar(opcoes) {
  const forcar = Boolean(opcoes && opcoes.forcar);
  const hostsExtras = (opcoes && opcoes.hostsExtras) || [];
  const envBanco = gerarEnvBanco();
  if (!forcar && materialCompleto()) {
    const novasIdentidades = completarCredenciais();
    return { gerado: false, envBanco, novasIdentidades, certificadoApi: garantirCertificadoApi(hostsExtras, false) };
  }
  gerarCertificados(hostsExtras);
  const identidades = gerarCredenciais();
  garantirCertificadoApi(hostsExtras, true);
  return { gerado: true, identidades, envBanco, novasIdentidades: [], certificadoApi: true };
}

module.exports = {
  gerar, reemitirCertificadoBroker, garantirCertificadoApi, hashSenha,
  ARQUIVOS, ARQUIVOS_API, ARQUIVO_ENV, materialCompleto
};

/* --broker-host 192.168.0.10 (pode repetir, ou separar por virgula). */
function hostsDaLinhaDeComando(argv) {
  const hosts = [];
  argv.forEach((a, i) => {
    if (a === '--broker-host' && argv[i + 1]) hosts.push(...argv[i + 1].split(','));
    else if (a.startsWith('--broker-host=')) hosts.push(...a.slice('--broker-host='.length).split(','));
  });
  return hosts.map((h) => h.trim()).filter(Boolean);
}

if (require.main === module) {
  const forcar = process.argv.includes('--forcar');
  const hostsExtras = hostsDaLinhaDeComando(process.argv);
  const r = gerar({ forcar, hostsExtras });
  if (r.envBanco.length) console.log(`Senhas do banco geradas em .env: ${r.envBanco.join(', ')}`);
  if (r.novasIdentidades.length) {
    console.log(`Identidades novas na ACL, senha gerada: ${r.novasIdentidades.join(', ')} (as demais nao mudaram)`);
  }
  if (!r.gerado && r.certificadoApi) {
    console.log('Certificado da API de historico emitido pela CA existente: certs/api.crt (a CA e as senhas nao mudaram).');
  }
  if (!r.gerado && hostsExtras.length) {
    const nomes = reemitirCertificadoBroker(hostsExtras);
    console.log(`Certificado do broker reemitido pela mesma CA, valido para: ${nomes.join(', ')}`);
    console.log('Reinicie o broker. A CA e as senhas nao mudaram.');
  } else if (!r.gerado) {
    console.log('Material de seguranca ja existe. Use `npm run seguranca -- --forcar` para regenerar.');
  } else {
    console.log('Material de seguranca gerado em seguranca/:');
    console.log('  certs/ca.crt        CA propria (os clientes confiam nela)');
    console.log(`  certs/broker.crt    certificado do broker (${altNamesBroker(hostsExtras).map((n) => n.ip || n.value).join(', ')})`);
    console.log('  credenciais.json    hashes scrypt -- usado pelo broker');
    console.log('  segredos.json       senhas em claro -- usado pelos clientes');
    console.log(`  identidades         ${r.identidades.join(', ')}`);
  }
}

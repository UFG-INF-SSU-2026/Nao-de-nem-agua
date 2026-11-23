'use strict';
/*
 * Gera o material de seguranca do caminho A -- `npm run seguranca`.
 *
 *   certs/ca.crt, certs/ca.key          autoridade certificadora PROPRIA do grupo
 *   certs/broker.crt, certs/broker.key  certificado do broker, assinado pela CA,
 *                                       valido para localhost e 127.0.0.1
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

function gerarCertificados() {
  const agora = new Date();
  const validade = new Date(agora);
  validade.setFullYear(validade.getFullYear() + 2);

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

  // --- Broker ---
  const broker = parDeChaves();
  const brokerCert = forge.pki.createCertificate();
  brokerCert.publicKey = broker.pub;
  brokerCert.serialNumber = serial();
  brokerCert.validity.notBefore = agora;
  brokerCert.validity.notAfter = validade;
  brokerCert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  brokerCert.setIssuer(caNome);
  brokerCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      // O cliente confere o NOME do servidor contra esta lista. E isso que impede
      // um terceiro com outro certificado da mesma CA de se passar pelo broker.
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
      ]
    },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
  ]);
  brokerCert.sign(ca.priv, forge.md.sha256.create());

  fs.mkdirSync(CERTS, { recursive: true });
  fs.writeFileSync(ARQUIVOS.caCrt, forge.pki.certificateToPem(caCert));
  fs.writeFileSync(ARQUIVOS.caKey, ca.pem, { mode: 0o600 });
  fs.writeFileSync(ARQUIVOS.brokerCrt, forge.pki.certificateToPem(brokerCert));
  fs.writeFileSync(ARQUIVOS.brokerKey, broker.pem, { mode: 0o600 });
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

/* Gera o que faltar. Com forcar=true, regenera tudo (invalida senhas e certificados antigos). */
function gerar(opcoes) {
  const forcar = Boolean(opcoes && opcoes.forcar);
  if (!forcar && materialCompleto()) return { gerado: false };
  gerarCertificados();
  const identidades = gerarCredenciais();
  return { gerado: true, identidades };
}

module.exports = { gerar, hashSenha, ARQUIVOS, materialCompleto };

if (require.main === module) {
  const forcar = process.argv.includes('--forcar');
  const r = gerar({ forcar });
  if (!r.gerado) {
    console.log('Material de seguranca ja existe. Use `npm run seguranca -- --forcar` para regenerar.');
  } else {
    console.log('Material de seguranca gerado em seguranca/:');
    console.log('  certs/ca.crt        CA propria (os clientes confiam nela)');
    console.log('  certs/broker.crt    certificado do broker (localhost, 127.0.0.1)');
    console.log('  credenciais.json    hashes scrypt -- usado pelo broker');
    console.log('  segredos.json       senhas em claro -- usado pelos clientes');
    console.log(`  identidades         ${r.identidades.join(', ')}`);
  }
}

'use strict';
/*
 * Broker MQTT local (Aedes) -- caminho A, agora com as tres camadas de seguranca.
 *
 * Papel na arquitetura: MIDDLEWARE. Nao pertence ao produtor nem ao consumidor
 * -- media a interacao entre eles. E ele quem roteia por topico, mantem a
 * sessao e publica a will message (LWT) quando um cliente morre sem se
 * despedir. Nenhuma regra de NEGOCIO vive aqui; a regra de ACESSO, sim: o
 * broker e o unico ponto por onde toda mensagem passa, e portanto o lugar
 * certo para barrar quem nao deveria falar.
 *
 *   1. CANAL        so aceita TLS (mqtts://, porta 8883). Nao ha porta em
 *                   texto puro: um cliente que tente MQTT sem TLS nao completa
 *                   nem o handshake.
 *   2. IDENTIDADE   authenticate: usuario/senha conferidos contra hash scrypt.
 *                   O clientId precisa comecar pela identidade -- sem isso, uma
 *                   identidade valida poderia usar o clientId de outra e
 *                   derruba-la (o MQTT desconecta a sessao anterior de mesmo id).
 *   3. AUTORIZACAO  authorizePublish / authorizeSubscribe: ACL por papel,
 *                   amarrada ao vaso (seguranca/acl.json). Para gateways, o
 *                   broker confere tambem o deviceId DENTRO do payload.
 *
 * Por que Aedes e nao Mosquitto em container: a maquina de apresentacao nao tem
 * Docker instalado. Aedes e um broker MQTT de verdade que sobe com `node`, e os
 * ganchos de autenticacao e autorizacao sao funcoes JavaScript -- o que deixa a
 * politica de seguranca legivel no proprio repositorio.
 */

const tls = require('tls');
const aedesFactory = require('aedes');
const { carregarConfig } = require('../contrato');
const seguranca = require('../seguranca');

const cfg = carregarConfig();
const PORTA = cfg.mqtt.brokerPort;
const acl = seguranca.carregarAcl(cfg.identidade.prefixoTopico);

const aedes = aedesFactory();

function agora() {
  return new Date().toISOString().slice(11, 23);
}

const CORES = { reset: '\x1b[0m', vermelho: '\x1b[31m', verde: '\x1b[32m' };

function log(evento, detalhe) {
  console.log(`[${agora()}] broker  ${evento.padEnd(22)} ${detalhe || ''}`);
}

function negado(evento, detalhe) {
  console.log(`${CORES.vermelho}[${agora()}] broker  ${evento.padEnd(22)} ${detalhe || ''}${CORES.reset}`);
}

/* Codigos de retorno do CONNACK no MQTT 3.1.1. */
const RC_USUARIO_OU_SENHA = 4;
const RC_NAO_AUTORIZADO = 5;

function recusar(codigo, mensagem) {
  const erro = new Error(mensagem);
  erro.returnCode = codigo;
  return erro;
}

// ---------------------------------------------------------------------------
// 2. Identidade
// ---------------------------------------------------------------------------

aedes.authenticate = (cliente, usuario, senha, cb) => {
  const id = cliente.id;

  if (!usuario || !senha) {
    negado('AUTH_RECUSADA', `${id}: sem credenciais`);
    return cb(recusar(RC_NAO_AUTORIZADO, 'credenciais ausentes'), false);
  }

  const senhaTexto = senha.toString('utf8');
  if (!acl[usuario] || !seguranca.verificarSenha(usuario, senhaTexto)) {
    // A mensagem e a mesma para usuario inexistente e senha errada: diferenciar
    // as duas diria a um atacante quais usuarios existem.
    negado('AUTH_RECUSADA', `${id}: usuario ou senha invalidos (usuario=${usuario})`);
    return cb(recusar(RC_USUARIO_OU_SENHA, 'usuario ou senha invalidos'), false);
  }

  if (!id.startsWith(usuario)) {
    negado('AUTH_RECUSADA', `${id}: clientId nao pertence a identidade ${usuario}`);
    return cb(recusar(RC_NAO_AUTORIZADO, 'clientId incompativel com a identidade'), false);
  }

  // A identidade autenticada fica presa ao cliente: e ela, e nao o clientId
  // nem o conteudo das mensagens, que a autorizacao consulta daqui em diante.
  cliente.identidade = acl[usuario];
  log('AUTENTICADO', `${id} como ${usuario} (papel ${acl[usuario].papel})`);
  cb(null, true);
};

// ---------------------------------------------------------------------------
// 3. Autorizacao
// ---------------------------------------------------------------------------

/*
 * Chamado para cada PUBLISH de cliente e tambem para a will message, no momento
 * em que o broker vai publica-la. Recusar um PUBLISH faz o Aedes encerrar a
 * conexao do cliente: no MQTT 3.1.1 nao existe resposta "publicacao negada", e
 * um cliente que tenta publicar onde nao pode esta se comportando mal.
 */
aedes.authorizePublish = (cliente, pacote, cb) => {
  const ident = cliente && cliente.identidade;
  const topico = pacote.topic;

  if (topico.startsWith('$SYS')) return cb(new Error('$SYS e reservado ao broker'));

  if (!ident) {
    negado('PUBLISH_NEGADO', `cliente sem identidade -> ${topico}`);
    return cb(new Error('sem identidade'));
  }

  if (!seguranca.podePublicar(ident, topico)) {
    negado('PUBLISH_NEGADO', `${cliente.id} (${ident.papel}) nao pode publicar em ${topico}`);
    return cb(new Error('publicacao nao autorizada'));
  }

  /*
   * Anti-falsificacao de origem. O topico ja esta amarrado ao vaso; o que ainda
   * poderia mentir e o payload. Um gateway autenticado como sim-vaso-01 nao pode
   * publicar uma leitura que diga deviceId=esp32-vaso-01.
   *
   * So se afirma falsificacao quando ha o que comparar: um payload que nem e
   * JSON nao se passa por ninguem, e e rejeitado depois, pelo contrato, no
   * consumidor.
   */
  if (ident.verificarDeviceId) {
    let corpo = null;
    try {
      corpo = JSON.parse(pacote.payload.toString('utf8'));
    } catch (e) {
      corpo = null;
    }
    if (corpo && typeof corpo === 'object' && corpo.deviceId !== ident.deviceId) {
      negado('PUBLISH_NEGADO', `${cliente.id}: deviceId do payload (${corpo.deviceId}) != identidade (${ident.deviceId})`);
      return cb(new Error('deviceId falsificado'));
    }
  }

  cb(null);
};

/*
 * Assinatura negada nao derruba a conexao: o broker responde SUBACK 0x80
 * (falha) para aquele filtro e segue. O cliente fica sabendo, e o resto da
 * sessao continua.
 */
aedes.authorizeSubscribe = (cliente, sub, cb) => {
  const ident = cliente && cliente.identidade;
  if (!ident || !seguranca.podeAssinar(ident, sub.topic)) {
    negado('SUBSCRIBE_NEGADO', `${cliente && cliente.id} (${ident ? ident.papel : '?'}) nao pode assinar ${sub.topic}`);
    return cb(null, null);
  }
  cb(null, sub);
};

// ---------------------------------------------------------------------------
// Observabilidade
// ---------------------------------------------------------------------------

aedes.on('clientReady', (cliente) => log('CONNECT_PRONTO', cliente.id));

/*
 * Este evento dispara tanto na saida limpa (o cliente enviou DISCONNECT) quanto
 * na queda. O log NAO afirma qual dos dois foi: quem responde a essa pergunta e
 * a publicacao da will message, registrada abaixo como LWT_PUBLICADO.
 */
aedes.on('clientDisconnect', (cliente) => log('DESCONECTADO', cliente.id));

aedes.on('clientError', (cliente, erro) => log('ERRO_CLIENTE', `${cliente.id}: ${erro.message}`));

aedes.on('connectionError', (cliente, erro) =>
  negado('ERRO_CONEXAO', `${cliente && cliente.id}: ${erro.message}`)
);

aedes.on('subscribe', (subscricoes, cliente) =>
  log('SUBSCRIBE', `${cliente && cliente.id} -> ${subscricoes.map((s) => `${s.topic} (QoS ${s.qos})`).join(', ')}`)
);

aedes.on('publish', (pacote, cliente) => {
  if (!cliente) return; // pacotes internos do proprio broker ($SYS)

  const conteudo = pacote.payload ? pacote.payload.toString() : '';

  if (conteudo.includes('"state":"OFFLINE"')) {
    log('LWT_PUBLICADO', `em nome de ${cliente.id} -> ${pacote.topic} (a conexao caiu)`);
    return;
  }

  const retido = pacote.retain ? ' [retained]' : '';
  const assinado = /,"sig":"[0-9a-f]{64}"\}$/.test(conteudo) ? ' [assinado]' : '';
  log('PUBLISH', `${cliente.id} -> ${pacote.topic} (QoS ${pacote.qos})${retido}${assinado}`);
});

// ---------------------------------------------------------------------------
// 1. Canal: TLS
// ---------------------------------------------------------------------------

const servidor = tls.createServer(
  {
    ...seguranca.certificadosBroker(),
    // TLS 1.2 e o minimo aceitavel hoje; versoes anteriores tem ataques conhecidos.
    minVersion: 'TLSv1.2'
  },
  aedes.handle
);

/*
 * Falha no handshake TLS: cliente em texto puro, cliente que nao confia na
 * nossa CA, versao de TLS antiga. A conexao nunca chega ao MQTT.
 */
servidor.on('tlsClientError', (erro, socket) => {
  negado('TLS_RECUSADO', `${socket.remoteAddress || '?'}: ${erro.code || erro.message}`);
});

servidor.listen(PORTA, () => {
  log('OUVINDO', `mqtts://localhost:${PORTA} (TLS obrigatorio)`);
  console.log('');
  console.log('  Middleware com seguranca: canal TLS (CA propria), usuario/senha por');
  console.log(`  identidade e ACL por papel. Identidades: ${Object.keys(acl).join(', ')}`);
  console.log('  Encerre com Ctrl+C.');
  console.log('');
});

function encerrar() {
  log('ENCERRANDO', 'clientes serao desconectados');
  aedes.close(() => servidor.close(() => process.exit(0)));
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

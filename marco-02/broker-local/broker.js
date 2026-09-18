'use strict';
/*
 * Broker MQTT local (Aedes).
 *
 * Papel na arquitetura: MIDDLEWARE. Nao pertence ao produtor nem ao consumidor
 * -- media a interacao entre eles. E ele quem roteia por topico, mantem a
 * sessao e publica a will message (LWT) quando um cliente morre sem se
 * despedir. Nenhuma regra de negocio vive aqui.
 *
 * Por que Aedes e nao Mosquitto em container: a maquina de apresentacao nao tem
 * Docker instalado. Aedes e um broker MQTT de verdade que sobe com `node`, o
 * que elimina dependencia de infraestrutura no dia da verificacao. O papel
 * arquitetural e identico.
 *
 * Este broker e o caminho A (offline, deterministico). O caminho B usa o broker
 * publico broker.hivemq.com, necessario porque o ESP32 simulado no Wokwi nao
 * alcanca o localhost desta maquina. Trocar de caminho e mudar MQTT_URL.
 */

const net = require('net');
const aedesFactory = require('aedes');
const { carregarConfig } = require('../contrato');

const cfg = carregarConfig();
const PORTA = cfg.mqtt.brokerPort;

const aedes = aedesFactory();
const servidor = net.createServer(aedes.handle);

function agora() {
  return new Date().toISOString().slice(11, 23);
}

function log(evento, detalhe) {
  console.log(`[${agora()}] broker  ${evento.padEnd(22)} ${detalhe || ''}`);
}

aedes.on('client', (cliente) => log('CONNECT', cliente.id));

aedes.on('clientReady', (cliente) => log('CONNECT_PRONTO', cliente.id));

/*
 * Este evento dispara tanto na saida limpa (o cliente enviou DISCONNECT) quanto
 * na queda. O log NAO afirma qual dos dois foi: quem responde a essa pergunta e
 * a publicacao da will message, registrada abaixo como LWT_PUBLICADO. Se
 * aparecer um LWT logo em seguida, a conexao caiu; se nao aparecer, o cliente se
 * despediu.
 */
aedes.on('clientDisconnect', (cliente) => log('DESCONECTADO', cliente.id));

aedes.on('clientError', (cliente, erro) =>
  log('ERRO_CLIENTE', `${cliente.id}: ${erro.message}`)
);

aedes.on('connectionError', (cliente, erro) =>
  log('ERRO_CONEXAO', `${cliente && cliente.id}: ${erro.message}`)
);

aedes.on('subscribe', (subscricoes, cliente) =>
  log('SUBSCRIBE', `${cliente && cliente.id} -> ${subscricoes.map((s) => `${s.topic} (QoS ${s.qos})`).join(', ')}`)
);

aedes.on('publish', (pacote, cliente) => {
  if (!cliente) return; // pacotes internos do proprio broker ($SYS)

  const conteudo = pacote.payload ? pacote.payload.toString() : '';

  /*
   * A will message sai por este mesmo caminho, mas nao foi o cliente que a
   * enviou -- foi o broker, em nome dele, porque a conexao terminou sem
   * DISCONNECT. Separar as duas no log e o que torna a falha F1 legivel para
   * quem esta assistindo.
   */
  if (conteudo.includes('"state":"OFFLINE"')) {
    log('LWT_PUBLICADO', `em nome de ${cliente.id} -> ${pacote.topic} (a conexao caiu)`);
    return;
  }

  const retido = pacote.retain ? ' [retained]' : '';
  log('PUBLISH', `${cliente.id} -> ${pacote.topic} (QoS ${pacote.qos})${retido}`);
});

servidor.listen(PORTA, () => {
  log('OUVINDO', `mqtt://localhost:${PORTA}`);
  console.log('');
  console.log('  Este broker exerce a funcao de middleware: roteia por topico,');
  console.log('  mantem sessao e publica o LWT em quedas abruptas.');
  console.log('  Encerre com Ctrl+C -- e exatamente assim que a falha F1 e provocada.');
  console.log('');
});

function encerrar() {
  log('ENCERRANDO', 'clientes serao desconectados; LWT sera entregue aos assinantes');
  aedes.close(() => servidor.close(() => process.exit(0)));
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

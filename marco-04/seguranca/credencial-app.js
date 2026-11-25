'use strict';
/*
 * `npm run app:credencial` -- mostra a credencial de TESTE do aplicativo nesta
 * maquina, para digitar na tela de login do app.
 *
 * A senha e gerada por `npm run seguranca` (aleatoria, por maquina) e fica em
 * seguranca/segredos.json, fora do Git. Este comando so a le e imprime no
 * terminal de quem o executa: nada e enviado a lugar nenhum, e ela nao entra no
 * APK nem no repositorio. E a credencial do papel `app` (so le o proprio vaso e
 * so publica pedidos e luz) -- nunca uma credencial administrativa.
 */

const seguranca = require('.');
const contrato = require('../contrato');

const cfg = contrato.carregarConfig();
const usuario = process.argv[2] || `app-${cfg.identidade.vasoId}`;
const acl = seguranca.carregarAcl(cfg.identidade.prefixoTopico);

if (!acl[usuario] || acl[usuario].papel !== 'app') {
  console.error(`${usuario} nao e uma identidade de papel app em seguranca/acl.json.`);
  process.exit(1);
}

console.log('');
console.log('Credencial de teste do aplicativo (gerada nesta maquina; NAO versionar):');
console.log('');
console.log(`  Servidor  localhost   (pelo cabo: adb reverse tcp:8883 tcp:8883 e tcp:8443 tcp:8443)`);
console.log(`  Porta     ${cfg.mqtt.brokerPort}`);
console.log(`  Usuario   ${usuario}`);
console.log(`  Senha     ${seguranca.senhaDe(usuario)}`);
console.log(`  Vaso      ${acl[usuario].vasoId}`);
console.log('');
console.log('Com o celular no cabo, para digitar a senha no campo selecionado do app:');
console.log('  adb shell input text <senha>');
console.log('');

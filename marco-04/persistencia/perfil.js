'use strict';
/*
 * Marco 4 -- perfil de cuidado por especie, grupo e vaso.
 *
 * Resolve a limitacao "um vaso, uma especie" do marco-04.md: os limiares que
 * dependem da planta deixam de ser so do config.json e passam a vir do
 * cadastro. Ordem (o ultimo vence):
 *
 *   config.json  <-  especie  <-  grupo  <-  vaso  <-  variavel de ambiente
 *
 * - especie: o que a planta precisa (suculenta gosta de solo seco).
 * - grupo:   o que o lugar impoe (varanda com sol seca mais rapido).
 * - vaso:    excecao daquele vaso.
 * - ambiente: a "alteracao ao vivo" do README continua vencendo tudo.
 *
 * Funcoes PURAS: nada aqui acessa banco ou rede (testadas em
 * persistencia/test/perfil.test.js). Cada camada e validada contra
 * contrato/v1/perfil-cuidado.schema.json; camada invalida e IGNORADA (com
 * motivo) e o resultado combinado ainda precisa ser coerente (liga < desliga,
 * EC min < EC max), senao nada e aplicado.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'contrato', 'v1', 'perfil-cuidado.schema.json'), 'utf8')
);
const validador = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);

/* 'regra.limiarLiga', 'ambiente.umidadeArMin', ... -- derivado do schema. */
const CHAVES = Object.entries(SCHEMA.properties).flatMap(([secao, def]) =>
  Object.keys(def.properties).map((chave) => `${secao}.${chave}`)
);

function validarPerfil(parametros) {
  if (parametros === null || parametros === undefined) return { ok: true };
  if (!validador(parametros)) {
    const detalhe = (validador.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    return { ok: false, detalhe };
  }
  return { ok: true };
}

function ler(obj, chave) {
  const [secao, campo] = chave.split('.');
  return obj && obj[secao] ? obj[secao][campo] : undefined;
}

/* Valores atuais do cfg para as chaves de perfil (o "padrao" do config.json). */
function capturarPadrao(cfg) {
  const padrao = {};
  for (const chave of CHAVES) padrao[chave] = ler(cfg, chave);
  return padrao;
}

/*
 * camadas: [{ origem: 'especie:suculenta', parametros: {...} }, ...] na ordem
 * de precedencia crescente. sobrescritas: { 'regra.limiarLiga': 45 } vindas do
 * ambiente (cfg.sobrescritasAmbiente).
 *
 * Devolve { ok, valores: { chave: { valor, origem } }, ignoradas: [...], erro }.
 */
function resolverPerfil(padrao, camadas, sobrescritas) {
  const valores = {};
  for (const chave of CHAVES) valores[chave] = { valor: padrao[chave], origem: 'config.json' };

  const ignoradas = [];
  for (const camada of camadas || []) {
    if (!camada || !camada.parametros) continue;
    const v = validarPerfil(camada.parametros);
    if (!v.ok) {
      ignoradas.push({ origem: camada.origem, motivo: v.detalhe });
      continue;
    }
    for (const chave of CHAVES) {
      const valor = ler(camada.parametros, chave);
      if (valor !== undefined) valores[chave] = { valor, origem: camada.origem };
    }
  }
  for (const [chave, valor] of Object.entries(sobrescritas || {})) {
    if (chave in valores) valores[chave] = { valor, origem: 'variavel de ambiente' };
  }

  const v = (k) => valores[k].valor;
  if (!(v('regra.limiarLiga') < v('regra.limiarDesliga'))) {
    return { ok: false, valores, ignoradas, erro: `limiarLiga (${v('regra.limiarLiga')}) precisa ser menor que limiarDesliga (${v('regra.limiarDesliga')})` };
  }
  if (!(v('adubacao.ec25MinUsCm') < v('adubacao.ec25MaxUsCm'))) {
    return { ok: false, valores, ignoradas, erro: `ec25MinUsCm (${v('adubacao.ec25MinUsCm')}) precisa ser menor que ec25MaxUsCm (${v('adubacao.ec25MaxUsCm')})` };
  }
  return { ok: true, valores, ignoradas };
}

/*
 * Aplica no cfg EM LUGAR (os modulos das regras leem cfg.regra.* a cada
 * decisao, entao a troca vale na proxima avaliacao). Devolve o que mudou.
 */
function aplicarPerfil(cfg, valores) {
  const mudancas = [];
  for (const [chave, { valor, origem }] of Object.entries(valores)) {
    const [secao, campo] = chave.split('.');
    const anterior = cfg[secao][campo];
    if (anterior !== valor) {
      cfg[secao][campo] = valor;
      mudancas.push({ chave, de: anterior, para: valor, origem });
    }
  }
  return mudancas;
}

/* Monta as camadas a partir da linha do cadastro (ver Persistencia.carregarCadastro). */
function camadasDoCadastro(cad) {
  if (!cad) return [];
  const camadas = [];
  if (cad.especie_id) camadas.push({ origem: `especie:${cad.especie_id}`, parametros: cad.especie_parametros });
  if (cad.grupo_id) camadas.push({ origem: `grupo:${cad.grupo_id}`, parametros: cad.grupo_parametros });
  camadas.push({ origem: `vaso:${cad.vaso_id}`, parametros: cad.vaso_parametros });
  return camadas;
}

module.exports = { CHAVES, validarPerfil, capturarPadrao, resolverPerfil, aplicarPerfil, camadasDoCadastro };

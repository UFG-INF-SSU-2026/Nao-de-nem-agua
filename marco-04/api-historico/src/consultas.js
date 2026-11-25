'use strict';
/*
 * Consultas da API de historico -- SOMENTE LEITURA, com o papel leitor_app.
 *
 * Toda entrada do usuario vira PARAMETRO ($1, $2...), nunca texto de SQL: o
 * vasoId ja passou por uma expressao regular restrita, e mesmo assim nao e
 * concatenado. O intervalo do time_bucket tambem e parametro (::interval).
 *
 * Solo e ar saem dos AGREGADOS CONTINUOS do TimescaleDB (solo_1min,
 * ambiente_1min, com materialized_only=false: inclui o minuto corrente), re-
 * agregados no passo pedido. Luz e reservatorios saem das hypertables com
 * time_bucket direto.
 */

const VASO_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/* Largura do ponto conforme o periodo: ~360 pontos no maximo por serie. */
function passoPara(horas) {
  if (horas <= 6) return 1;
  if (horas <= 48) return 5;
  return 30;
}

/*
 * Valida e normaliza os parametros. Devolve { ok, valores } ou { ok: false, motivo }.
 * Recusa em vez de "corrigir": um horas=9999 e um erro do cliente, nao um pedido
 * de 168 horas.
 */
function parametros(cfgApi, vasoId, query, padraoHoras) {
  if (!VASO_ID.test(vasoId || '')) return { ok: false, motivo: 'vasoId invalido' };
  const texto = query.get('horas');
  const horas = texto === null ? padraoHoras : Number(texto);
  if (!Number.isInteger(horas) || horas < 1 || horas > cfgApi.horasMax) {
    return { ok: false, motivo: `horas deve ser inteiro entre 1 e ${cfgApi.horasMax}` };
  }
  const textoLimite = query.get('limite');
  const limite = textoLimite === null ? 50 : Number(textoLimite);
  if (!Number.isInteger(limite) || limite < 1 || limite > cfgApi.limiteAlertas) {
    return { ok: false, motivo: `limite deve ser inteiro entre 1 e ${cfgApi.limiteAlertas}` };
  }
  return { ok: true, valores: { vasoId, horas, limite, passoMin: passoPara(horas) } };
}

const umaCasa = (v) => Math.round(Number(v) * 10) / 10;
const serie = (linhas, coluna) => linhas
  .filter((l) => l[coluna] !== null && l[coluna] !== undefined)
  .map((l) => ({ t: new Date(l.t).toISOString(), v: umaCasa(l[coluna]) }));

async function historico(q, { vasoId, horas, passoMin }) {
  const periodo = `${horas} hours`;
  const passo = `${passoMin} minutes`;
  const params = [vasoId, passo, periodo];

  const [solo, ar, luz, reservatorios, resumo] = await Promise.all([
    q(`SELECT time_bucket($2::interval, bucket) AS t, avg(umidade_media) AS v
         FROM naodenemagua.solo_1min
        WHERE vaso_id = $1 AND bucket >= now() - $3::interval
        GROUP BY t ORDER BY t`, params),
    q(`SELECT time_bucket($2::interval, bucket) AS t, avg(umidade_ar_media) AS umidade, avg(temperatura_media) AS temperatura
         FROM naodenemagua.ambiente_1min
        WHERE vaso_id = $1 AND bucket >= now() - $3::interval
        GROUP BY t ORDER BY t`, params),
    q(`SELECT time_bucket($2::interval, ts) AS t, avg(lux) AS v
         FROM naodenemagua.telemetria_luz
        WHERE vaso_id = $1 AND ts >= now() - $3::interval AND valida AND NOT atrasada
        GROUP BY t ORDER BY t`, params),
    q(`SELECT time_bucket($2::interval, ts) AS t, reservatorio, avg(nivel_pct) AS v
         FROM naodenemagua.telemetria_reservatorio
        WHERE vaso_id = $1 AND ts >= now() - $3::interval AND valida AND NOT replayed
        GROUP BY t, reservatorio ORDER BY t`, params),
    q(`SELECT
         (SELECT count(*) FROM naodenemagua.comandos
           WHERE vaso_id = $1 AND ts >= now() - $2::interval AND acao = 'PULSO_IRRIGACAO')::int AS irrigacoes,
         (SELECT count(*) FROM naodenemagua.comandos
           WHERE vaso_id = $1 AND ts >= now() - $2::interval AND atuador = 'BOMBA_ADUBO' AND acao = 'PULSO')::int AS doses,
         (SELECT count(*) FROM naodenemagua.alertas
           WHERE vaso_id = $1 AND ts >= now() - $2::interval)::int AS alertas`, [vasoId, periodo])
  ]);

  const ate = new Date();
  return {
    schemaVersion: 1,
    eventType: 'HistoricoVaso',
    entityId: vasoId,
    geradoEm: ate.toISOString(),
    de: new Date(ate.getTime() - horas * 3600000).toISOString(),
    ate: ate.toISOString(),
    horas,
    passoMin,
    series: {
      soloUmidadePct: serie(solo, 'v'),
      arUmidadePct: serie(ar, 'umidade'),
      arTemperaturaC: serie(ar, 'temperatura'),
      luzLux: serie(luz, 'v'),
      reservatorioAguaPct: serie(reservatorios.filter((l) => l.reservatorio === 'AGUA'), 'v'),
      reservatorioAduboPct: serie(reservatorios.filter((l) => l.reservatorio === 'ADUBO'), 'v')
    },
    resumo: { irrigacoes: resumo[0].irrigacoes, dosesAdubo: resumo[0].doses, alertas: resumo[0].alertas }
  };
}

async function alertas(q, { vasoId, horas, limite }) {
  const linhas = await q(
    `SELECT ts, tipo, severidade, mensagem FROM naodenemagua.alertas
      WHERE vaso_id = $1 AND ts >= now() - $2::interval
      ORDER BY ts DESC LIMIT $3`, [vasoId, `${horas} hours`, limite]);
  return {
    schemaVersion: 1,
    eventType: 'HistoricoAlertas',
    entityId: vasoId,
    geradoEm: new Date().toISOString(),
    horas,
    alertas: linhas.map((l) => ({
      ts: new Date(l.ts).toISOString(), tipo: l.tipo, severidade: l.severidade, mensagem: l.mensagem
    }))
  };
}

module.exports = { parametros, passoPara, historico, alertas, VASO_ID };

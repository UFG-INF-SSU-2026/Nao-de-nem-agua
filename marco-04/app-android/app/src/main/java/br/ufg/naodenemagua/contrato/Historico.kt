package br.ufg.naodenemagua.contrato

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeParseException

/*
 * Respostas da API de historico (contrato/v1/historico-vaso e historico-alertas).
 * Mesma politica dos contratos MQTT: fora da v1, do tipo ou dos campos
 * obrigatorios -> null, e a tela mostra "resposta invalida" em vez de quebrar.
 */

data class Ponto(val t: Instant, val v: Double)

data class HistoricoVaso(
    val entityId: String,
    val de: Instant,
    val ate: Instant,
    val horas: Int,
    val passoMin: Int,
    val soloUmidadePct: List<Ponto>,
    val arUmidadePct: List<Ponto>,
    val arTemperaturaC: List<Ponto>,
    val luzLux: List<Ponto>,
    val reservatorioAguaPct: List<Ponto>,
    val reservatorioAduboPct: List<Ponto>,
    val irrigacoes: Int,
    val dosesAdubo: Int,
    val alertas: Int
) {
    val vazio: Boolean
        get() = listOf(soloUmidadePct, arUmidadePct, luzLux, reservatorioAguaPct).all { it.isEmpty() }
}

data class AlertaRegistrado(val ts: Instant, val tipo: String, val severidade: String, val mensagem: String)

object Historico {

    fun vaso(texto: String): HistoricoVaso? = abrir(texto, "HistoricoVaso") { j ->
        val s = j.getJSONObject("series")
        val r = j.getJSONObject("resumo")
        HistoricoVaso(
            entityId = j.getString("entityId"),
            de = Instant.parse(j.getString("de")),
            ate = Instant.parse(j.getString("ate")),
            horas = j.getInt("horas"),
            passoMin = j.getInt("passoMin"),
            soloUmidadePct = serie(s.getJSONArray("soloUmidadePct")),
            arUmidadePct = serie(s.getJSONArray("arUmidadePct")),
            arTemperaturaC = serie(s.getJSONArray("arTemperaturaC")),
            luzLux = serie(s.getJSONArray("luzLux")),
            reservatorioAguaPct = serie(s.getJSONArray("reservatorioAguaPct")),
            reservatorioAduboPct = serie(s.getJSONArray("reservatorioAduboPct")),
            irrigacoes = r.getInt("irrigacoes"),
            dosesAdubo = r.getInt("dosesAdubo"),
            alertas = r.getInt("alertas")
        )
    }

    fun alertas(texto: String): List<AlertaRegistrado>? = abrir(texto, "HistoricoAlertas") { j ->
        val a = j.getJSONArray("alertas")
        (0 until a.length()).map { i ->
            val x = a.getJSONObject(i)
            AlertaRegistrado(
                ts = Instant.parse(x.getString("ts")),
                tipo = x.getString("tipo"),
                severidade = x.getString("severidade"),
                mensagem = x.getString("mensagem")
            )
        }
    }

    private fun serie(a: JSONArray): List<Ponto> = (0 until a.length()).map { i ->
        val p = a.getJSONObject(i)
        Ponto(Instant.parse(p.getString("t")), p.getDouble("v"))
    }

    private inline fun <T> abrir(texto: String, tipo: String, ler: (JSONObject) -> T): T? = try {
        val j = JSONObject(texto)
        if (j.optInt("schemaVersion", -1) != VERSAO_SUPORTADA || j.optString("eventType") != tipo) null else ler(j)
    } catch (_: JSONException) {
        null
    } catch (_: DateTimeParseException) {
        null
    }
}

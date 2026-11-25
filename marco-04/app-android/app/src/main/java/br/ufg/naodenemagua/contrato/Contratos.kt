package br.ufg.naodenemagua.contrato

import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/*
 * Contratos v1 vistos pelo app (schemas em marco-04/contrato/v1). Mesma politica
 * do servico: payload que nao e da versao 1, nao e do tipo esperado ou nao tem
 * os campos obrigatorios e REJEITADO (null) -- nunca derruba o app nem vira
 * dado na tela. A validacao completa do schema fica com o servico, que produz
 * estas mensagens; aqui se confere o que a tela usa.
 */

const val VERSAO_SUPORTADA = 1

data class Reservatorio(val estado: String, val nivelPct: Double?)

/** R5 no servico (campo opcional do EstadoVaso). */
data class LuzServico(val estado: String, val luxMedia: Int?, val idadeMs: Long?)

data class EstadoVaso(
    val entityId: String,
    val generatedAt: Instant,
    val publishIntervalMs: Long,
    val soloEstado: String,
    val soloUmidadePct: Double?,
    val soloIdadeMs: Long?,
    val bombaLigada: Boolean,
    val arEstado: String,
    val arUmidadePct: Double?,
    val arTemperaturaC: Double?,
    val umidificadorLigado: Boolean,
    val reservatorios: Map<String, Reservatorio>,
    val irrigacaoBloqueada: Boolean,
    val irrigacaoMotivo: String?,
    val adubacaoEstado: String,
    val ec25UsCm: Double?,
    val dosesNaJanela: Int,
    val excessoNutrientes: Boolean,
    val falhaPendente: Boolean,
    /** IRRIGACAO / ADUBACAO: o que o reconhecimento libera (campo opcional da v1). */
    val falhasPendentes: Set<String> = emptySet(),
    val luz: LuzServico? = null
) {
    /** O servico parou? A mensagem e retida e sobrevive a ele; o pulso nao. */
    fun servicoParado(agoraMs: Long): Boolean =
        agoraMs - generatedAt.toEpochMilli() > 3 * publishIntervalMs
}

data class AlertaCuidado(
    val eventId: String,
    val alertType: String,
    val severity: String,
    val message: String,
    val correlationId: String,
    val issuedAt: Instant,
    val ttlMs: Long
) {
    fun vencido(agoraMs: Long): Boolean = agoraMs > issuedAt.toEpochMilli() + ttlMs
}

data class RespostaApp(
    val requestId: String,
    val action: String?,
    val result: String,
    val detail: String,
    val respondedAt: Instant
)

/** Heartbeat do dispositivo (retido); OFFLINE vem da will message do broker. */
data class EstadoConectividade(val deviceId: String, val state: String, val reason: String?)

object Contratos {

    fun estadoVaso(texto: String): EstadoVaso? = abrir(texto, "EstadoVaso") { j ->
        val solo = j.getJSONObject("solo")
        val ar = j.getJSONObject("ar")
        val irrigacao = j.getJSONObject("irrigacao")
        val adubacao = j.getJSONObject("adubacao")
        val res = j.getJSONObject("reservatorios")
        EstadoVaso(
            entityId = j.getString("entityId"),
            generatedAt = Instant.parse(j.getString("generatedAt")),
            publishIntervalMs = j.getLong("publishIntervalMs"),
            soloEstado = solo.getString("estado"),
            soloUmidadePct = solo.numeroOuNulo("umidadePct"),
            soloIdadeMs = solo.numeroOuNulo("idadeMs")?.toLong(),
            bombaLigada = solo.getBoolean("bombaLigada"),
            arEstado = ar.getString("estado"),
            arUmidadePct = ar.numeroOuNulo("umidadePct"),
            arTemperaturaC = ar.numeroOuNulo("temperaturaC"),
            umidificadorLigado = ar.getBoolean("umidificadorLigado"),
            reservatorios = res.keys().asSequence().associateWith { nome ->
                val r = res.getJSONObject(nome)
                Reservatorio(r.getString("estado"), r.numeroOuNulo("nivelPct"))
            },
            irrigacaoBloqueada = irrigacao.getBoolean("bloqueada"),
            irrigacaoMotivo = irrigacao.textoOuNulo("motivo"),
            adubacaoEstado = adubacao.getString("estado"),
            ec25UsCm = adubacao.numeroOuNulo("ec25UsCm"),
            dosesNaJanela = adubacao.getInt("dosesNaJanela"),
            excessoNutrientes = adubacao.getBoolean("excesso"),
            falhaPendente = j.getBoolean("falhaPendente"),
            falhasPendentes = j.optJSONArray("falhasPendentes")
                ?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
                ?: emptySet(),
            luz = j.optJSONObject("luz")?.let { l ->
                LuzServico(
                    estado = l.getString("estado"),
                    luxMedia = l.numeroOuNulo("luxMedia")?.toInt(),
                    idadeMs = l.numeroOuNulo("idadeMs")?.toLong()
                )
            }
        )
    }

    fun alerta(texto: String): AlertaCuidado? = abrir(texto, "AlertaCuidado") { j ->
        AlertaCuidado(
            eventId = j.getString("eventId"),
            alertType = j.getString("alertType"),
            severity = j.getString("severity").also { require(it in setOf("INFO", "ATENCAO", "CRITICO")) },
            message = j.getString("message"),
            correlationId = j.getString("correlationId"),
            issuedAt = Instant.parse(j.getString("issuedAt")),
            ttlMs = j.getLong("ttlMs").also { require(it >= 1) }
        )
    }

    fun resposta(texto: String): RespostaApp? = abrir(texto, "RespostaApp") { j ->
        RespostaApp(
            requestId = j.getString("requestId"),
            action = j.textoOuNulo("action"),
            result = j.getString("result"),
            detail = j.getString("detail"),
            respondedAt = Instant.parse(j.getString("respondedAt"))
        )
    }

    fun conectividade(texto: String): EstadoConectividade? = abrir(texto, "EstadoConectividade") { j ->
        EstadoConectividade(
            deviceId = j.getString("deviceId"),
            state = j.getString("state").also { require(it in setOf("ATIVO", "SILENCIOSO", "OFFLINE")) },
            reason = j.textoOuNulo("reason")
        )
    }

    /** Pedido do app (SolicitacaoApp v1). */
    fun solicitacao(
        requestId: String,
        deviceId: String,
        vasoId: String,
        action: String,
        criadoEm: Instant,
        ttlMs: Long
    ): String = JSONObject()
        .put("schemaVersion", VERSAO_SUPORTADA)
        .put("eventType", "SolicitacaoApp")
        .put("requestId", requestId)
        .put("deviceId", deviceId)
        .put("entityId", vasoId)
        .put("action", action)
        .put("createdAt", utc(criadoEm))
        .put("ttlMs", ttlMs)
        .toString()

    /** Leitura do sensor de luz do celular (LeituraLuz v1): o app como produtor. */
    fun leituraLuz(
        eventId: String,
        deviceId: String,
        vasoId: String,
        sequence: Int,
        medidoEm: Instant,
        lux: Double,
        amostras: Int,
        janelaMs: Long,
        sensor: String
    ): String = JSONObject()
        .put("schemaVersion", VERSAO_SUPORTADA)
        .put("eventId", eventId)
        .put("eventType", "LeituraLuz")
        .put("deviceId", deviceId)
        .put("entityId", vasoId)
        .put("sequence", sequence)
        .put("measuredAt", utc(medidoEm))
        .put("lux", Math.round(lux * 10) / 10.0)
        .put("samples", amostras)
        .put("windowMs", janelaMs)
        .put("sensor", sensor.take(80))
        .put("valid", true)
        .toString()

    /**
     * Instante no formato utc-date-time do contrato: no maximo milissegundos. O
     * Instant do Android tem microssegundos, que o servico recusaria.
     */
    internal fun utc(i: Instant): String = i.truncatedTo(ChronoUnit.MILLIS).toString()

    private inline fun <T> abrir(texto: String, tipo: String, ler: (JSONObject) -> T): T? = try {
        val j = JSONObject(texto)
        if (j.optInt("schemaVersion", -1) != VERSAO_SUPORTADA || j.optString("eventType") != tipo) null
        else ler(j)
    } catch (_: JSONException) {
        null
    } catch (_: DateTimeParseException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun JSONObject.numeroOuNulo(campo: String): Double? =
        if (!has(campo) || isNull(campo)) null else getDouble(campo)

    private fun JSONObject.textoOuNulo(campo: String): String? =
        if (!has(campo) || isNull(campo)) null else getString(campo)
}

package br.ufg.naodenemagua.conexao

import br.ufg.naodenemagua.contrato.AlertaRegistrado
import br.ufg.naodenemagua.contrato.Historico
import br.ufg.naodenemagua.contrato.HistoricoVaso
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocketFactory

/** Porta da API de historico (config.json, api.porta). Pelo cabo: adb reverse tcp:8443 tcp:8443. */
const val PORTA_API = 8443

sealed interface RespostaApi<out T> {
    data class Ok<T>(val valor: T) : RespostaApi<T>
    data class Falha(val mensagem: String, val dica: String = "") : RespostaApi<Nothing>
}

/**
 * Cliente da API de historico: HTTPS com a MESMA CA do grupo e verificacao do
 * nome do servidor (o verificador padrao do HttpsURLConnection), e a MESMA
 * identidade do broker (Basic, so dentro do TLS). Chamadas bloqueantes: o
 * ViewModel as faz em Dispatchers.IO.
 */
class HistoricoApi(private val config: ConfigConexao, private val tls: SSLSocketFactory) {

    private fun base() = "https://${config.host}:$PORTA_API/v1/vasos/${URLEncoder.encode(config.vasoId, "UTF-8")}"

    fun historico(horas: Int): RespostaApi<HistoricoVaso> =
        get("${base()}/historico?horas=$horas") { Historico.vaso(it) }

    fun alertas(horas: Int, limite: Int): RespostaApi<List<AlertaRegistrado>> =
        get("${base()}/alertas?horas=$horas&limite=$limite") { Historico.alertas(it) }

    private fun <T> get(url: String, ler: (String) -> T?): RespostaApi<T> {
        val c = URL(url).openConnection() as HttpsURLConnection
        return try {
            c.sslSocketFactory = tls
            c.connectTimeout = 6000
            c.readTimeout = 8000
            c.requestMethod = "GET"
            val cred = Base64.getEncoder().encodeToString("${config.usuario}:${config.senha}".toByteArray())
            c.setRequestProperty("Authorization", "Basic $cred")
            c.setRequestProperty("Accept", "application/json")
            val status = c.responseCode
            val corpo = (if (status in 200..299) c.inputStream else c.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            when (status) {
                HttpURLConnection.HTTP_OK -> ler(corpo)?.let { RespostaApi.Ok(it) }
                    ?: RespostaApi.Falha("Resposta da API fora do contrato.")
                401 -> RespostaApi.Falha("A API recusou o usuário ou a senha.")
                403 -> RespostaApi.Falha("Esta identidade não pode ler o histórico deste vaso.")
                429 -> RespostaApi.Falha("Muitas tentativas com senha errada.", "Aguarde ${c.getHeaderField("Retry-After") ?: "um"} s.")
                503 -> RespostaApi.Falha("Histórico indisponível: o banco não respondeu.", "O serviço de banco está no ar? (npm run banco)")
                else -> RespostaApi.Falha("A API respondeu $status.")
            }
        } catch (e: Exception) {
            falhaDeRede(e)
        } finally {
            c.disconnect()
        }
    }

    private fun falhaDeRede(e: Exception): RespostaApi.Falha = when (classificarRede(e)) {
        MotivoFalha.INALCANCAVEL -> RespostaApi.Falha(
            "API de histórico inalcançável.",
            "Ela está rodando (npm run api)? Pelo cabo: adb reverse tcp:$PORTA_API tcp:$PORTA_API."
        )
        MotivoFalha.TEMPO_ESGOTADO -> RespostaApi.Falha("A API não respondeu a tempo.")
        MotivoFalha.NOME_SERVIDOR -> RespostaApi.Falha(
            "O certificado da API não vale para este endereço.",
            "Gere-o com npm run seguranca -- --broker-host <IP>."
        )
        MotivoFalha.CERTIFICADO -> RespostaApi.Falha("O certificado da API não é da CA do grupo.")
        else -> RespostaApi.Falha("Falha de comunicação com a API.", e.javaClass.simpleName)
    }
}

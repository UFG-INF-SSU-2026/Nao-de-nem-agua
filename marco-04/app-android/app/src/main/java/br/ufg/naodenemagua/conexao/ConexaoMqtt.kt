package br.ufg.naodenemagua.conexao

import android.util.Log
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttException
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocketFactory
import kotlin.coroutines.resume

/** O que a tela mostra sobre o canal com o broker. */
sealed interface EstadoConexao {
    data object Desconectado : EstadoConexao
    data object Conectando : EstadoConexao
    data class Conectado(val desdeMs: Long) : EstadoConexao

    /** A conexao caiu depois de estabelecida; o cliente tenta voltar sozinho. */
    data class Reconectando(val causa: String, val desdeMs: Long) : EstadoConexao

    /** A primeira conexao falhou: nao adianta insistir sem o usuario agir. */
    data class Falha(val motivo: MotivoFalha, val detalhe: String) : EstadoConexao
}

enum class MotivoFalha(val mensagem: String, val dica: String) {
    CREDENCIAIS(
        "Usuário ou senha inválidos.",
        "Confira a senha do app-vaso-01 (gerada por npm run seguranca)."
    ),
    NAO_AUTORIZADO(
        "O broker recusou esta identidade.",
        "Use a identidade do app (app-vaso-01)."
    ),
    CERTIFICADO(
        "O certificado do broker não é da CA do grupo.",
        "Recompile o app depois de rodar npm run seguranca nesta máquina."
    ),
    NOME_SERVIDOR(
        "O certificado do broker não vale para este endereço.",
        "Pelo cabo use localhost; pelo Wi-Fi gere o certificado com --broker-host <IP>."
    ),
    INALCANCAVEL(
        "Broker inalcançável.",
        "O broker está rodando? Pelo cabo: adb reverse tcp:8883 tcp:8883."
    ),
    TEMPO_ESGOTADO(
        "O broker não respondeu a tempo.",
        "Verifique a rede e se a porta 8883 está liberada no firewall."
    ),
    DESCONHECIDO("Falha de comunicação com o broker.", "")
}

data class Mensagem(val topico: String, val texto: String, val retida: Boolean)

data class ConfigConexao(
    val host: String,
    val porta: Int,
    val usuario: String,
    val senha: String,
    val vasoId: String
)

/**
 * Cliente MQTT sobre TLS (Eclipse Paho), com os mesmos cuidados dos clientes
 * Node do projeto (contrato/index.js, conectar()):
 *  - TLS obrigatorio, confiando so na CA do grupo, com verificacao do NOME do
 *    servidor contra o certificado;
 *  - usuario/senha da identidade, com clientId iniciado por ela (exigencia do
 *    broker);
 *  - reconexao automatica depois que a conexao ja existiu.
 */
class ConexaoMqtt(
    private val config: ConfigConexao,
    private val fabricaTls: SSLSocketFactory
) {
    val topicos = Topicos(config.vasoId)

    /** Identidade autenticada; vai como deviceId nos pedidos (o broker confere). */
    val usuario: String get() = config.usuario

    private val _estado = MutableStateFlow<EstadoConexao>(EstadoConexao.Desconectado)
    val estado: StateFlow<EstadoConexao> = _estado.asStateFlow()

    private val _mensagens = MutableSharedFlow<Mensagem>(
        extraBufferCapacity = 128,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    val mensagens: SharedFlow<Mensagem> = _mensagens.asSharedFlow()

    /** Filtros que o broker recusou (SUBACK 0x80). Deve ficar vazio. */
    private val _assinaturasNegadas = MutableStateFlow<List<String>>(emptyList())
    val assinaturasNegadas: StateFlow<List<String>> = _assinaturasNegadas.asStateFlow()

    private val cliente = MqttAsyncClient(
        "ssl://${config.host}:${config.porta}",
        "${config.usuario}-android-${UUID.randomUUID().toString().take(8)}",
        MemoryPersistence() // o padrao grava em disco no diretorio corrente, que no Android nao existe
    )

    private var encerrada = false

    init {
        cliente.setCallback(object : MqttCallbackExtended {
            override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                Log.i(TAG, if (reconnect) "reconectado" else "conectado a $serverURI")
                _estado.value = EstadoConexao.Conectado(System.currentTimeMillis())
                // Sessao limpa: as assinaturas se perdem na queda e sao refeitas.
                assinar()
            }

            override fun connectionLost(cause: Throwable?) {
                Log.w(TAG, "conexao perdida", cause)
                if (encerrada) return
                _estado.value = EstadoConexao.Reconectando(
                    causa = cause?.message ?: "conexão encerrada pelo broker",
                    desdeMs = System.currentTimeMillis()
                )
            }

            override fun messageArrived(topic: String, message: MqttMessage) {
                _mensagens.tryEmit(Mensagem(topic, String(message.payload, Charsets.UTF_8), message.isRetained))
            }

            override fun deliveryComplete(token: IMqttDeliveryToken?) = Unit
        })
    }

    fun conectar() {
        encerrada = false
        _estado.value = EstadoConexao.Conectando
        val opcoes = MqttConnectOptions().apply {
            mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
            userName = config.usuario
            password = config.senha.toCharArray()
            socketFactory = fabricaTls
            // Verificacao do nome pelo verificador do proprio Android: o
            // certificado precisa nomear o host usado (localhost, ou o IP
            // incluido com --broker-host). Sem isso, qualquer certificado da
            // mesma CA serviria.
            isHttpsHostnameVerificationEnabled = false
            sslHostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
            isCleanSession = true
            connectionTimeout = 8
            keepAliveInterval = 20
            isAutomaticReconnect = true
            maxReconnectDelay = 8000
        }
        try {
            cliente.connect(opcoes, null, object : IMqttActionListener {
                override fun onSuccess(asyncActionToken: IMqttToken?) = Unit // connectComplete trata

                override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                    Log.w(TAG, "falha ao conectar", exception)
                    val motivo = exception?.let(::classificar) ?: MotivoFalha.DESCONHECIDO
                    _estado.value = EstadoConexao.Falha(motivo, exception?.let(::descrever) ?: "")
                }
            })
        } catch (e: MqttException) {
            _estado.value = EstadoConexao.Falha(classificar(e), descrever(e))
        }
    }

    private fun assinar() {
        val filtros = topicos.assinaturas
        try {
            cliente.subscribe(filtros.toTypedArray(), IntArray(filtros.size) { 1 }, null,
                object : IMqttActionListener {
                    override fun onSuccess(token: IMqttToken) {
                        val concedidos = token.grantedQos ?: intArrayOf()
                        _assinaturasNegadas.value = filtros.filterIndexed { i, _ -> concedidos.getOrNull(i) == 0x80 }
                    }

                    override fun onFailure(token: IMqttToken?, exception: Throwable?) {
                        Log.w(TAG, "assinatura recusada", exception)
                        _assinaturasNegadas.value = filtros
                    }
                })
        } catch (e: MqttException) {
            Log.w(TAG, "falha ao assinar", e)
        }
    }

    /** Publica e espera o PUBACK (QoS 1). Devolve null em caso de sucesso, ou a falha. */
    suspend fun publicar(topico: String, texto: String): Throwable? =
        suspendCancellableCoroutine { cont ->
            try {
                cliente.publish(topico, texto.toByteArray(Charsets.UTF_8), 1, false, null,
                    object : IMqttActionListener {
                        override fun onSuccess(asyncActionToken: IMqttToken?) {
                            if (cont.isActive) cont.resume(null)
                        }

                        override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                            if (cont.isActive) cont.resume(exception ?: IllegalStateException("falha ao publicar"))
                        }
                    })
            } catch (e: MqttException) {
                if (cont.isActive) cont.resume(e)
            }
        }

    fun encerrar() {
        encerrada = true
        _estado.value = EstadoConexao.Desconectado
        try {
            if (cliente.isConnected) cliente.disconnect(500).waitForCompletion(1000)
        } catch (_: MqttException) {
            // ja estava caindo; nada a fazer
        } finally {
            try { cliente.close(true) } catch (_: MqttException) { }
        }
    }

    companion object {
        private const val TAG = "ConexaoMqtt"
    }
}

/** Traduz a excecao do Paho/TLS no motivo que o usuario consegue agir. */
internal fun classificar(e: Throwable): MotivoFalha {
    if (e is MqttException) {
        when (e.reasonCode) {
            MqttException.REASON_CODE_FAILED_AUTHENTICATION.toInt() -> return MotivoFalha.CREDENCIAIS
            MqttException.REASON_CODE_NOT_AUTHORIZED.toInt() -> return MotivoFalha.NAO_AUTORIZADO
            MqttException.REASON_CODE_CLIENT_TIMEOUT.toInt() -> return MotivoFalha.TEMPO_ESGOTADO
        }
    }
    return classificarRede(e) ?: MotivoFalha.DESCONHECIDO
}

/**
 * Falhas de rede/TLS comuns ao MQTT e a API de historico.
 *
 * Um SSLHandshakeException so e problema de CERTIFICADO quando a causa e de
 * certificado. Pelo cabo (adb reverse), o adb aceita a conexao no celular e so a
 * fecha quando o PC recusa: o handshake "falha" com a conexao encerrada -- e o
 * servidor esta fora do ar, nao com certificado errado. Achado no aparelho.
 */
internal fun classificarRede(e: Throwable): MotivoFalha? {
    val cadeia = generateSequence(e) { it.cause }.take(10).toList()
    val mensagens = cadeia.joinToString(" ") { it.message.orEmpty() }.lowercase()
    if (cadeia.any { it is SSLPeerUnverifiedException } || "subject alternative" in mensagens ||
        ("hostname" in mensagens && "not verified" in mensagens)) return MotivoFalha.NOME_SERVIDOR
    if (cadeia.any { it is CertPathValidatorException || it is CertificateException } || "trust anchor" in mensagens) {
        return MotivoFalha.CERTIFICADO
    }
    if (cadeia.any { it is SocketTimeoutException }) return MotivoFalha.TEMPO_ESGOTADO
    if (cadeia.any { it is ConnectException || it is UnknownHostException || it is NoRouteToHostException ||
            it is SSLHandshakeException || it is java.io.EOFException || it is java.net.SocketException }) {
        return MotivoFalha.INALCANCAVEL
    }
    return null
}

private fun descrever(e: Throwable): String =
    generateSequence(e) { it.cause }.take(10).lastOrNull { !it.message.isNullOrBlank() }
        ?.let { "${it.javaClass.simpleName}: ${it.message}" }
        ?: e.javaClass.simpleName

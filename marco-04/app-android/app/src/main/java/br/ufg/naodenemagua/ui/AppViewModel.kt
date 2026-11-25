package br.ufg.naodenemagua.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import br.ufg.naodenemagua.conexao.Assinaturas
import br.ufg.naodenemagua.conexao.Autenticidade
import br.ufg.naodenemagua.conexao.ConexaoMqtt
import br.ufg.naodenemagua.conexao.MaterialAssinatura
import br.ufg.naodenemagua.conexao.ConfigConexao
import br.ufg.naodenemagua.conexao.EstadoConexao
import br.ufg.naodenemagua.conexao.Mensagem
import br.ufg.naodenemagua.conexao.TlsDoGrupo
import br.ufg.naodenemagua.contrato.Contratos
import br.ufg.naodenemagua.contrato.EstadoConectividade
import br.ufg.naodenemagua.contrato.EstadoVaso
import br.ufg.naodenemagua.dados.Preferencias
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import br.ufg.naodenemagua.conexao.HistoricoApi
import br.ufg.naodenemagua.conexao.RespostaApi
import br.ufg.naodenemagua.sensor.JanelaLuz
import br.ufg.naodenemagua.sensor.SensorLuz
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface Tela {
    /** Lendo as preferencias salvas. */
    data object Abrindo : Tela
    /** Primeira abertura: apresentacao do app antes do login. */
    data object BoasVindas : Tela
    data class Login(val config: ConfigConexao) : Tela
    data object Painel : Tela
}

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val preferencias = Preferencias(app)

    private val _tela = MutableStateFlow<Tela>(Tela.Abrindo)
    val tela: StateFlow<Tela> = _tela.asStateFlow()

    private val conexaoAtual = MutableStateFlow<ConexaoMqtt?>(null)

    val estadoConexao: StateFlow<EstadoConexao> = conexaoAtual
        .flatMapLatest { it?.estado ?: flowOf(EstadoConexao.Desconectado) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, EstadoConexao.Desconectado)

    val assinaturasNegadas: StateFlow<List<String>> = conexaoAtual
        .flatMapLatest { it?.assinaturasNegadas ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val _estadoVaso = MutableStateFlow<EstadoVaso?>(null)
    val estadoVaso: StateFlow<EstadoVaso?> = _estadoVaso.asStateFlow()

    private val _dispositivo = MutableStateFlow<EstadoConectividade?>(null)
    val dispositivo: StateFlow<EstadoConectividade?> = _dispositivo.asStateFlow()

    /** Mensagens descartadas por estarem fora do contrato (diagnostico). */
    private val _rejeitadas = MutableStateFlow(0)
    val rejeitadas: StateFlow<Int> = _rejeitadas.asStateFlow()

    /**
     * Mensagens descartadas por NAO terem a assinatura do servico: invalida em
     * qualquer broker, ou ausente no broker publico. No publico, um numero
     * crescendo aqui e alguem publicando nos topicos do vaso.
     */
    private val _naoAutenticadas = MutableStateFlow(0)
    val naoAutenticadas: StateFlow<Int> = _naoAutenticadas.asStateFlow()

    /** Chave publica do servico e chave HMAC do app, embutidas no APK pelo build. */
    private val material: MaterialAssinatura? by lazy { runCatching { MaterialAssinatura.carregar(app) }.getOrNull() }

    /** Alertas desta sessao, mais novo primeiro, sem duplicados (eventId). */
    private val _alertas = MutableStateFlow<List<AlertaRecebido>>(emptyList())
    val alertas: StateFlow<List<AlertaRecebido>> = _alertas.asStateFlow()

    private val _pedido = MutableStateFlow<Pedido?>(null)
    val pedido: StateFlow<Pedido?> = _pedido.asStateFlow()
    private var esperaResposta: Job? = null

    private var coleta: Job? = null
    private var configAtual: ConfigConexao? = null

    /** Dados da conexao em uso (para a aba Conexao); a senha nao e exibida. */
    private val _config = MutableStateFlow<ConfigConexao?>(null)
    val config: StateFlow<ConfigConexao?> = _config.asStateFlow()

    // -------------------------------------------------------------------------
    // Sensor de luz do celular: o app como PRODUTOR (LeituraLuz)
    // -------------------------------------------------------------------------

    private val sensorLuz = SensorLuz(app)
    val sensorLuzDisponivel: Boolean = sensorLuz.disponivel
    val nomeSensorLuz: String = sensorLuz.nome

    private val _medirLuz = MutableStateFlow(true)
    val medirLuz: StateFlow<Boolean> = _medirLuz.asStateFlow()

    private val _luzLocal = MutableStateFlow(LuzLocal())
    val luzLocal: StateFlow<LuzLocal> = _luzLocal.asStateFlow()

    private var emPrimeiroPlano = false
    private var medicao: Job? = null

    // -------------------------------------------------------------------------
    // Historico (API HTTPS, somente leitura, sobre o TimescaleDB)
    // -------------------------------------------------------------------------

    private val _historico = MutableStateFlow<EstadoHistorico>(EstadoHistorico.Ocioso)
    val historico: StateFlow<EstadoHistorico> = _historico.asStateFlow()

    private val _periodoHoras = MutableStateFlow(6)
    val periodoHoras: StateFlow<Int> = _periodoHoras.asStateFlow()
    private var carga: Job? = null

    fun escolherPeriodo(horas: Int) {
        _periodoHoras.value = horas
        carregarHistorico()
    }

    /** Busca series e alertas; uma carga por vez (a nova cancela a anterior). */
    fun carregarHistorico() {
        val config = configAtual ?: return
        if (config.publico) {
            // A API e do grupo e pede a senha do app, que nao vai para o broker publico.
            _historico.value = EstadoHistorico.Indisponivel
            return
        }
        val horas = _periodoHoras.value
        carga?.cancel()
        _historico.value = EstadoHistorico.Carregando(horas)
        carga = viewModelScope.launch {
            val api = HistoricoApi(config, withContext(Dispatchers.IO) { TlsDoGrupo.fabricaDeSockets(getApplication()) })
            val serie = withContext(Dispatchers.IO) { api.historico(horas) }
            val alertasBanco = withContext(Dispatchers.IO) { api.alertas(horas.coerceAtLeast(24), 30) }
            _historico.value = when {
                serie is RespostaApi.Falha -> EstadoHistorico.Erro(serie.mensagem, serie.dica)
                alertasBanco is RespostaApi.Falha -> EstadoHistorico.Erro(alertasBanco.mensagem, alertasBanco.dica)
                else -> EstadoHistorico.Pronto(
                    (serie as RespostaApi.Ok).valor,
                    (alertasBanco as RespostaApi.Ok).valor,
                    System.currentTimeMillis()
                )
            }
        }
    }

    /** Chamado pela Activity (onStart/onStop): mede so com o app na tela. */
    fun primeiroPlano(visivel: Boolean) {
        emPrimeiroPlano = visivel
        atualizarMedicao()
    }

    fun alternarMedicaoLuz(ligar: Boolean) {
        _medirLuz.value = ligar
        atualizarMedicao()
    }

    private fun atualizarMedicao() {
        val deveMedir = emPrimeiroPlano && _medirLuz.value && sensorLuz.disponivel && _tela.value == Tela.Painel
        if (deveMedir && medicao == null) {
            medicao = viewModelScope.launch { medirEPublicarLuz() }
        } else if (!deveMedir) {
            medicao?.cancel()
            medicao = null
            _luzLocal.value = _luzLocal.value.copy(luxAtual = null)
        }
    }

    /**
     * A cada INTERVALO_LUZ_MS fecha a janela de amostras e publica uma LeituraLuz.
     * Sem conexao, a leitura e descartada (luz de 1 minuto atras nao serve para
     * decidir agora -- o servico tambem a recusaria como atrasada).
     */
    private suspend fun medirEPublicarLuz() = coroutineScope {
        val sessao = UUID.randomUUID().toString().replace("-", "").take(8)
        var sequencia = 0
        val janela = JanelaLuz()
        launch {
            sensorLuz.leituras().collect { lux ->
                janela.adicionar(lux)
                _luzLocal.value = _luzLocal.value.copy(luxAtual = lux)
            }
        }
        while (isActive) {
            delay(INTERVALO_LUZ_MS)
            val (media, amostras) = janela.fechar() ?: continue
            val conexao = conexaoAtual.value
            if (conexao == null || estadoConexao.value !is EstadoConexao.Conectado) {
                _luzLocal.value = _luzLocal.value.copy(aviso = "Leitura não publicada: sem conexão com o broker.")
                continue
            }
            sequencia += 1
            val texto = Contratos.leituraLuz(
                eventId = "${conexao.usuario}:$sessao:$sequencia",
                deviceId = conexao.usuario,
                vasoId = conexao.topicos.vasoId,
                sequence = sequencia,
                medidoEm = Instant.now(),
                lux = media,
                amostras = amostras,
                janelaMs = INTERVALO_LUZ_MS,
                sensor = sensorLuz.nome
            )
            val assinado = paraPublicar(conexao.topicos.luz, texto)
            if (assinado == null) {
                _luzLocal.value = _luzLocal.value.copy(aviso = SEM_CHAVE)
                continue
            }
            val erro = withContext(Dispatchers.IO) { conexao.publicar(conexao.topicos.luz, assinado) }
            _luzLocal.value = if (erro == null) {
                _luzLocal.value.copy(
                    publicadas = _luzLocal.value.publicadas + 1,
                    ultimaPublicacaoMs = System.currentTimeMillis(),
                    ultimoLuxPublicado = media,
                    aviso = null
                )
            } else {
                _luzLocal.value.copy(aviso = "Leitura não publicada: ${erro.message ?: "falha de comunicação"}.")
            }
        }
    }

    init {
        viewModelScope.launch {
            val salva = preferencias.ler()
            when {
                !preferencias.boasVindasVista() -> _tela.value = Tela.BoasVindas
                // Senha lembrada (ou broker publico com "lembrar"): entra direto.
                preferencias.entrarDireto(salva) -> iniciar(salva)
                else -> _tela.value = Tela.Login(salva)
            }
        }
    }

    fun concluirBoasVindas() {
        viewModelScope.launch {
            preferencias.marcarBoasVindasVista()
            _tela.value = Tela.Login(preferencias.ler())
        }
    }

    fun entrar(config: ConfigConexao, lembrarSenha: Boolean) {
        viewModelScope.launch {
            preferencias.salvar(config, lembrarSenha)
            iniciar(config)
        }
    }

    fun tentarDeNovo() {
        configAtual?.let { c -> viewModelScope.launch { iniciar(c) } }
    }

    /** Volta ao login esquecendo a senha (por exemplo depois de CREDENCIAIS). */
    fun sair() {
        viewModelScope.launch {
            encerrarConexao()
            preferencias.esquecerSenha()
            _tela.value = Tela.Login(preferencias.ler())
            atualizarMedicao()
        }
    }

    private suspend fun iniciar(config: ConfigConexao) {
        encerrarConexao()
        configAtual = config
        _config.value = config
        _estadoVaso.value = null
        _dispositivo.value = null
        _alertas.value = emptyList()
        _pedido.value = null
        _historico.value = EstadoHistorico.Ocioso
        _naoAutenticadas.value = 0
        _tela.value = Tela.Painel
        val conexao = withContext(Dispatchers.IO) {
            ConexaoMqtt(config, TlsDoGrupo.fabricaPara(getApplication(), config.modo))
        }
        coleta = viewModelScope.launch { conexao.mensagens.collect(::tratar) }
        conexaoAtual.value = conexao
        atualizarMedicao()
        withContext(Dispatchers.IO) { conexao.conectar() }
    }

    private fun tratar(m: Mensagem) {
        val t = conexaoAtual.value?.topicos ?: return
        val publico = configAtual?.publico == true
        when {
            m.topico == t.estado -> if (doServico(m, publico)) {
                Contratos.estadoVaso(m.texto)?.let(::aceitarEstado) ?: rejeitar()
            }
            // O sinal de vida vem do DISPOSITIVO, assinado com a chave dele -- que
            // o app nao tem. No broker publico nao ha como conferir: e ignorado, e
            // "dispositivo offline" chega pelo EstadoVaso, que o servico assina.
            m.topico == t.heartbeat -> if (!publico) {
                Contratos.conectividade(m.texto)?.let { _dispositivo.value = it } ?: rejeitar()
            }
            m.topico == t.resposta -> if (doServico(m, publico)) {
                Contratos.resposta(m.texto)?.let(::tratarResposta) ?: rejeitar()
            }
            m.topico.startsWith(t.base + "/alert/") -> if (doServico(m, publico)) {
                Contratos.alerta(m.texto)?.let(::guardarAlerta) ?: rejeitar()
            }
        }
    }

    /**
     * A mensagem foi assinada pelo servico? Assinatura invalida e sempre
     * descartada; ausente, so no broker publico (no do grupo, a ACL garante
     * que so o servico publica nesses topicos).
     */
    private fun doServico(m: Mensagem, publico: Boolean): Boolean {
        val chave = material?.chavePublicaServico
        val autenticidade = if (chave == null) Autenticidade.AUSENTE else Assinaturas.verificarServico(chave, m.topico, m.texto)
        val aceita = when (autenticidade) {
            Autenticidade.VALIDA -> true
            Autenticidade.AUSENTE -> !publico
            Autenticidade.INVALIDA -> false
        }
        if (!aceita) _naoAutenticadas.value += 1
        return aceita
    }

    /**
     * Estado mais velho que o que ja esta na tela e descartado: uma mensagem
     * antiga, mesmo legitima e assinada, republicada por um terceiro nao pode
     * voltar a tela para um "tudo certo" do passado.
     */
    private fun aceitarEstado(e: EstadoVaso) {
        val atual = _estadoVaso.value
        if (atual != null && e.generatedAt.isBefore(atual.generatedAt)) return
        _estadoVaso.value = e
    }

    /**
     * Texto pronto para publicar: assinado com a chave HMAC do app quando o
     * APK tem uma para este usuario e vaso. No broker publico a assinatura e
     * obrigatoria -- sem chave, null (nao publica).
     */
    private fun paraPublicar(topico: String, texto: String): String? {
        val config = configAtual ?: return null
        val chave = material?.chaveDoApp(config.usuario, config.vasoId)
        return when {
            chave != null -> Assinaturas.assinarApp(chave, topico, texto)
            config.publico -> null
            else -> texto
        }
    }

    private fun guardarAlerta(a: br.ufg.naodenemagua.contrato.AlertaCuidado) {
        // QoS 1 entrega "pelo menos uma vez": o mesmo alerta pode chegar duas vezes.
        if (_alertas.value.any { it.alerta.eventId == a.eventId }) return
        _alertas.value = (listOf(AlertaRecebido(a, System.currentTimeMillis())) + _alertas.value).take(MAX_ALERTAS)
    }

    // -------------------------------------------------------------------------
    // Reconhecer falha: SolicitacaoApp -> RespostaApp
    // -------------------------------------------------------------------------

    fun reconhecerFalha() {
        val atual = _pedido.value
        if (atual is Pedido.Enviando || atual is Pedido.Aguardando) return // um de cada vez
        val conexao = conexaoAtual.value ?: return
        val agora = System.currentTimeMillis()
        val (requestId, criadoEm) = if (atual != null && atual.reaproveitavel(agora)) {
            atual.requestId to atual.criadoEm
        } else {
            UUID.randomUUID().toString() to Instant.ofEpochMilli(agora)
        }
        _pedido.value = Pedido.Enviando(requestId, criadoEm)
        viewModelScope.launch {
            val texto = Contratos.solicitacao(
                requestId = requestId,
                deviceId = conexao.usuario,
                vasoId = conexao.topicos.vasoId,
                action = "RECONHECER_FALHA",
                criadoEm = criadoEm,
                ttlMs = PEDIDO_TTL_MS
            )
            val assinado = paraPublicar(conexao.topicos.solicitacao, texto)
            if (assinado == null) {
                _pedido.value = Pedido.FalhaEnvio(requestId, criadoEm, SEM_CHAVE)
                return@launch
            }
            val erro = withContext(Dispatchers.IO) { conexao.publicar(conexao.topicos.solicitacao, assinado) }
            // A resposta pode ter chegado antes do PUBACK: nao sobrescrever.
            if (_pedido.value?.requestId != requestId || _pedido.value is Pedido.Concluido) return@launch
            if (erro != null) {
                _pedido.value = Pedido.FalhaEnvio(requestId, criadoEm, "Sem conexão com o broker.")
                return@launch
            }
            _pedido.value = Pedido.Aguardando(requestId, criadoEm)
            esperaResposta?.cancel()
            esperaResposta = viewModelScope.launch {
                delay(PEDIDO_ESPERA_RESPOSTA_MS)
                val p = _pedido.value
                if (p is Pedido.Aguardando && p.requestId == requestId) _pedido.value = Pedido.SemResposta(requestId, criadoEm)
            }
        }
    }

    private fun tratarResposta(r: br.ufg.naodenemagua.contrato.RespostaApp) {
        val p = _pedido.value ?: return
        if (p.requestId != r.requestId) return // resposta de outro pedido (ou de outra sessao)
        esperaResposta?.cancel()
        _pedido.value = Pedido.Concluido(p.requestId, p.criadoEm, r)
    }

    fun dispensarPedido() {
        val p = _pedido.value
        if (p is Pedido.Enviando || p is Pedido.Aguardando) return
        _pedido.value = null
    }

    private fun rejeitar() {
        _rejeitadas.value += 1
    }

    private suspend fun encerrarConexao() {
        coleta?.cancel()
        coleta = null
        val antiga = conexaoAtual.value ?: return
        conexaoAtual.value = null
        withContext(Dispatchers.IO) { antiga.encerrar() }
    }

    override fun onCleared() {
        conexaoAtual.value?.let { c -> Thread { c.encerrar() }.start() }
    }

    private companion object {
        const val MAX_ALERTAS = 50
        const val INTERVALO_LUZ_MS = 5_000L
        const val SEM_CHAVE = "Este APK não tem chave para assinar como este usuário (rode npm run seguranca e recompile)."
    }
}

sealed interface EstadoHistorico {
    data object Ocioso : EstadoHistorico
    data class Carregando(val horas: Int) : EstadoHistorico

    /** Broker publico: a API do grupo nao se usa sem a senha do grupo. */
    data object Indisponivel : EstadoHistorico
    data class Erro(val mensagem: String, val dica: String) : EstadoHistorico
    data class Pronto(
        val historico: br.ufg.naodenemagua.contrato.HistoricoVaso,
        val alertas: List<br.ufg.naodenemagua.contrato.AlertaRegistrado>,
        val carregadoEmMs: Long
    ) : EstadoHistorico
}

/** O que o celular mediu e publicou (o que o servico concluiu vem no EstadoVaso). */
data class LuzLocal(
    val luxAtual: Float? = null,
    val publicadas: Int = 0,
    val ultimaPublicacaoMs: Long? = null,
    val ultimoLuxPublicado: Double? = null,
    val aviso: String? = null
)

data class AlertaRecebido(val alerta: br.ufg.naodenemagua.contrato.AlertaCuidado, val recebidoEmMs: Long)

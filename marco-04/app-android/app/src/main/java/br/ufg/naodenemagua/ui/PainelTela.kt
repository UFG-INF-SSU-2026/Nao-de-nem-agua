package br.ufg.naodenemagua.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.conexao.ConfigConexao
import br.ufg.naodenemagua.conexao.EstadoConexao
import br.ufg.naodenemagua.conexao.MotivoFalha
import br.ufg.naodenemagua.contrato.EstadoConectividade
import br.ufg.naodenemagua.contrato.EstadoVaso

/** Tudo o que o painel mostra, num lugar so. */
data class DadosPainel(
    val conexao: EstadoConexao,
    val estado: EstadoVaso?,
    val dispositivo: EstadoConectividade?,
    val alertas: List<AlertaRecebido>,
    val pedido: Pedido?,
    val assinaturasNegadas: List<String>,
    val rejeitadas: Int,
    val luz: DadosLuz,
    val historico: EstadoHistorico,
    val periodoHoras: Int,
    val config: ConfigConexao? = null,
    /** Mensagens descartadas por falta de assinatura valida do servico. */
    val naoAutenticadas: Int = 0
) {
    val publico: Boolean get() = config?.publico == true
}

/** Sensor do celular: o que se mede aqui e o que o servico concluiu. */
data class DadosLuz(
    val disponivel: Boolean,
    val nomeSensor: String,
    val medir: Boolean,
    val local: LuzLocal
)

class AcoesPainel(
    val tentarDeNovo: () -> Unit,
    val sair: () -> Unit,
    val reconhecerFalha: () -> Unit,
    val dispensarPedido: () -> Unit,
    val alternarMedicaoLuz: (Boolean) -> Unit,
    val escolherPeriodo: (Int) -> Unit,
    val carregarHistorico: () -> Unit
)

private enum class Aba(val rotulo: String, val icone: ImageVector) {
    VASO("Vaso", Icones.Vaso),
    ALERTAS("Alertas", Icones.Sino),
    HISTORICO("Histórico", Icones.Grafico),
    CONEXAO("Conexão", Icones.Ajustes)
}

private val SOLO_COM_PROBLEMA = setOf("LEITURA_INVALIDA", "DISPOSITIVO_OFFLINE", "DADO_OBSOLETO")

@Composable
fun PainelTela(dados: DadosPainel, acoes: AcoesPainel, modifier: Modifier = Modifier) {
    val agora = agoraMs()
    var abaIndice by rememberSaveable { mutableIntStateOf(0) }
    val aba = Aba.entries[abaIndice]
    val ativos = dados.alertas.count { !it.alerta.vencido(agora) }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { Cabecalho(dados.config?.vasoId, dados.conexao, dados.publico) },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest, tonalElevation = 0.dp) {
                Aba.entries.forEach { a ->
                    NavigationBarItem(
                        selected = aba == a,
                        onClick = { abaIndice = a.ordinal },
                        icon = {
                            if (a == Aba.ALERTAS && ativos > 0) {
                                BadgedBox(badge = { Badge { Text("$ativos") } }) { Icon(a.icone, a.rotulo) }
                            } else {
                                Icon(a.icone, a.rotulo)
                            }
                        },
                        label = { Text(a.rotulo) },
                        colors = NavigationBarItemDefaults.colors(
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            selectedTextColor = MaterialTheme.colorScheme.primary
                        )
                    )
                }
            }
        }
    ) { margens ->
        Crossfade(aba, Modifier.padding(margens), label = "aba") { atual ->
            when (atual) {
                Aba.VASO -> AbaVaso(dados, acoes, agora) { abaIndice = Aba.CONEXAO.ordinal }
                Aba.ALERTAS -> AlertasTela(dados.alertas, agora)
                Aba.HISTORICO -> HistoricoTela(dados.historico, dados.periodoHoras, agora, acoes.escolherPeriodo, acoes.carregarHistorico)
                Aba.CONEXAO -> AjustesTela(dados, acoes, agora)
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Cabecalho
// -----------------------------------------------------------------------------

@Composable
private fun Cabecalho(vasoId: String?, conexao: EstadoConexao, publico: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Image(Icones.Logo, contentDescription = null, modifier = Modifier.size(38.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Não dê nem água", style = MaterialTheme.typography.titleLarge)
            if (vasoId != null) {
                Text(
                    if (publico) "$vasoId · broker público" else vasoId,
                    style = MaterialTheme.typography.bodySmall, color = CINZA
                )
            }
        }
        PilulaConexao(conexao)
    }
}

@Composable
internal fun PilulaConexao(conexao: EstadoConexao) {
    when (conexao) {
        EstadoConexao.Desconectado -> Pilula("Desconectado", Sinal.NEUTRO, icone = Icones.Wifi)
        EstadoConexao.Conectando -> Pilula("Conectando", Sinal.ATENCAO, carregando = true)
        is EstadoConexao.Conectado -> Pilula("Online", Sinal.OK)
        is EstadoConexao.Reconectando -> Pilula("Reconectando", Sinal.ATENCAO, carregando = true)
        is EstadoConexao.Falha -> Pilula("Sem conexão", Sinal.ERRO, icone = Icones.Erro)
    }
}

// -----------------------------------------------------------------------------
// Aba Vaso
// -----------------------------------------------------------------------------

@Composable
private fun AbaVaso(dados: DadosPainel, acoes: AcoesPainel, agora: Long, verConexao: () -> Unit) {
    val conexao = dados.conexao
    val conectado = conexao is EstadoConexao.Conectado
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        when (conexao) {
            is EstadoConexao.Falha -> CartaoFalhaConexao(conexao, acoes, dados.publico)
            EstadoConexao.Desconectado, EstadoConexao.Conectando -> Conectando()
            is EstadoConexao.Reconectando -> Aviso(
                "Conexão perdida há ${duracao(agora - conexao.desdeMs)} — reconectando sozinho. (${conexao.causa})",
                Sinal.ATENCAO
            )
            is EstadoConexao.Conectado -> Unit
        }
        if (dados.naoAutenticadas > 0) {
            Aviso(
                "${dados.naoAutenticadas} mensagem(ns) sem a assinatura do serviço foram descartadas" +
                    if (dados.publico) " — alguém está publicando nos tópicos deste vaso no broker público." else ".",
                Sinal.ERRO
            )
        }
        if (conexao is EstadoConexao.Conectado || conexao is EstadoConexao.Reconectando) {
            val estado = dados.estado
            AnimatedVisibility(estado?.falhaPendente == true || dados.pedido != null) {
                CartaoFalha(estado, dados.pedido, conectado, acoes)
            }
            CartaoSaude(estado, agora, conectado, dados.luz)
            if (estado != null) {
                CartaoReservatorios(estado)
                CartaoSolo(estado)
                CartaoAr(estado)
                CartaoAdubacao(estado)
            }
            CartaoLuz(dados.luz, estado, agora, conectado, acoes.alternarMedicaoLuz)
            CartaoDispositivo(dados.dispositivo, conectado, dados.publico, estado)
        }
        if (dados.assinaturasNegadas.isNotEmpty()) {
            Aviso("O broker recusou algumas assinaturas. Detalhes na aba Conexão.", Sinal.ERRO)
            OutlinedButton(onClick = verConexao) { Text("Ver detalhes") }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun Conectando() {
    EstadoVazio(
        Icones.Wifi,
        "Conectando ao vaso…",
        "Abrindo a conexão segura com o broker (TLS, CA do grupo)."
    ) {
        LinearProgressIndicator(Modifier.width(160.dp))
    }
}

@Composable
private fun CartaoFalhaConexao(conexao: EstadoConexao.Falha, acoes: AcoesPainel, publico: Boolean) {
    // As dicas padrao falam do broker do grupo (adb reverse, CA do grupo); no
    // publico o que costuma faltar e a internet do celular ou a porta 8883.
    val dica = if (!publico) conexao.motivo.dica else when (conexao.motivo) {
        MotivoFalha.INALCANCAVEL, MotivoFalha.TEMPO_ESGOTADO ->
            "Confira a internet do celular. Algumas redes bloqueiam a porta 8883: se continuar, tente outra rede (Wi-Fi ou dados)."
        MotivoFalha.CERTIFICADO, MotivoFalha.NOME_SERVIDOR ->
            "O certificado apresentado não é o do broker público. A rede pode estar interceptando a conexão."
        else -> conexao.motivo.dica
    }
    CartaoSecao("Não foi possível conectar", Icones.Wifi, sinal = Sinal.ERRO) {
        Text(conexao.motivo.mensagem, style = MaterialTheme.typography.titleSmall, color = VERMELHO)
        if (dica.isNotEmpty()) Text(dica, style = MaterialTheme.typography.bodyMedium)
        if (conexao.detalhe.isNotEmpty()) {
            Text(conexao.detalhe, style = MaterialTheme.typography.bodySmall, color = CINZA)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = acoes.tentarDeNovo) {
                Icon(Icones.Atualizar, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Tentar de novo")
            }
            OutlinedButton(onClick = acoes.sair) { Text("Alterar dados") }
        }
    }
}

// -----------------------------------------------------------------------------
// Saude da planta (resumo no topo)
// -----------------------------------------------------------------------------

private data class Humor(val titulo: String, val texto: String, val sinal: Sinal, val icone: ImageVector)

/**
 * Le o estado inteiro e diz, em uma frase, como a planta esta. A ordem importa:
 * o que pede acao do usuario vem antes do que so informa.
 */
private fun humor(e: EstadoVaso?, conectado: Boolean, agora: Long): Humor {
    val agua = e?.reservatorios?.get("AGUA")
    return when {
        e == null -> Humor("Procurando seu vaso…", "Aguardando o primeiro estado do serviço.", Sinal.NEUTRO, Icones.Relogio)
        !conectado -> Humor("Sem notícias agora", "Mostrando o último estado recebido.", Sinal.NEUTRO, Icones.Wifi)
        e.servicoParado(agora) -> Humor("O serviço não responde", "Os valores abaixo podem estar velhos.", Sinal.ERRO, Icones.Erro)
        e.falhaPendente -> Humor("Precisa de você", "Uma falha aguarda o seu reconhecimento.", Sinal.ERRO, Icones.Mao)
        agua?.estado == "CRITICO" -> Humor("Precisa de você", "O reservatório de água está no fim.", Sinal.ERRO, Icones.Reservatorio)
        e.irrigacaoBloqueada -> Humor("Precisa de você", "Irrigação bloqueada: ${Rotulos.motivoBloqueio(e.irrigacaoMotivo)}.", Sinal.ERRO, Icones.Alerta)
        e.soloEstado in SOLO_COM_PROBLEMA -> Humor("Sensor com problema", Rotulos.estadoSolo(e.soloEstado) + ".", Sinal.ERRO, Icones.Termometro)
        e.excessoNutrientes -> Humor("Nutrientes demais", "Regar com água pura ajuda a equilibrar.", Sinal.ATENCAO, Icones.Frasco)
        e.bombaLigada -> Humor("Bebendo água", "A bomba está irrigando agora.", Sinal.INFO, Icones.Gota)
        e.soloEstado == "AUTORIZADO" || e.soloEstado == "AGUARDANDO" ->
            Humor("Com sede", Rotulos.estadoSolo(e.soloEstado) + ".", Sinal.INFO, Icones.Gota)
        e.reservatorios.values.any { it.estado == "BAIXO" } ->
            Humor("Quase tudo certo", "Um reservatório está baixo — reabasteça em breve.", Sinal.ATENCAO, Icones.Reservatorio)
        e.luz?.estado == "POUCA_LUZ" || e.luz?.estado == "LUZ_EXCESSIVA" ->
            Humor("Quase tudo certo", Rotulos.estadoLuz(e.luz.estado) + " para a planta.", Sinal.ATENCAO, Icones.Sol)
        else -> Humor("Tudo certo por aqui", "Solo, ar e reservatórios em ordem.", Sinal.OK, Icones.Folha)
    }
}

@Composable
private fun CartaoSaude(estado: EstadoVaso?, agora: Long, conectado: Boolean, luz: DadosLuz) {
    val h = humor(estado, conectado, agora)
    val corSolo = when (estado?.soloEstado) {
        "AUTORIZADO", "AGUARDANDO" -> AMARELO
        in SOLO_COM_PROBLEMA -> VERMELHO
        else -> AZUL
    }
    Card(
        Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.extraLarge,
        colors = CardDefaults.cardColors(containerColor = Color.Transparent)
    ) {
        Column(
            Modifier
                .background(
                    Brush.linearGradient(
                        listOf(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.secondaryContainer)
                    )
                )
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Medidor(estado?.soloUmidadePct?.let { (it / 100).toFloat() }, corSolo, tamanho = 124.dp) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icones.Gota, null, tint = corSolo, modifier = Modifier.size(18.dp))
                        Text(
                            estado?.soloUmidadePct?.let { "%.0f%%".format(it) } ?: "—",
                            style = MaterialTheme.typography.headlineMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                        Text("solo", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f))
                    }
                }
                Spacer(Modifier.width(18.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    IconeRedondo(h.icone, h.sinal.cor(), MaterialTheme.colorScheme.surfaceContainerLowest.copy(alpha = 0.8f), 32.dp)
                    Text(h.titulo, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    Text(h.texto, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f))
                }
            }
            if (estado != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MiniMetrica(Icones.Vento, estado.arUmidadePct?.let { "%.0f%%".format(it) } ?: "—", "ar", Modifier.weight(1f))
                    MiniMetrica(Icones.Termometro, estado.arTemperaturaC?.let { "%.1f°".format(it) } ?: "—", "temp.", Modifier.weight(1f))
                    val lux = luz.local.luxAtual?.let { "%.0f".format(it) } ?: estado.luz?.luxMedia?.toString() ?: "—"
                    MiniMetrica(Icones.Sol, lux, "lux", Modifier.weight(1f))
                }
            }
            StatusServico(estado, agora, conectado)
        }
    }
}

@Composable
private fun MiniMetrica(icone: ImageVector, valor: String, rotulo: String, modifier: Modifier) {
    Row(
        modifier
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainerLowest.copy(alpha = 0.75f))
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icone, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(valor, style = MaterialTheme.typography.titleSmall)
            Text(rotulo, style = MaterialTheme.typography.labelSmall, color = CINZA)
        }
    }
}

@Composable
private fun StatusServico(estado: EstadoVaso?, agora: Long, conectado: Boolean) {
    when {
        estado == null -> Pilula("Aguardando o estado do vaso", Sinal.NEUTRO, carregando = true)
        // Sem broker nao ha como saber do servico: mostrar "ativo" seria afirmar o que nao se sabe.
        !conectado -> Pilula("Último estado há ${duracao(agora - estado.generatedAt.toEpochMilli())}", Sinal.NEUTRO, icone = Icones.Relogio)
        estado.servicoParado(agora) ->
            Pilula("Serviço sem resposta há ${duracao(agora - estado.generatedAt.toEpochMilli())}", Sinal.ERRO, icone = Icones.Erro)
        else -> Pilula("Serviço ativo · atualizado há ${duracao(agora - estado.generatedAt.toEpochMilli())}", Sinal.OK)
    }
}

// -----------------------------------------------------------------------------
// Falha pendente / pedido de reconhecimento
// -----------------------------------------------------------------------------

/**
 * Falha pendente e o pedido de reconhecimento. Os estados do pedido sao os que
 * o PDF cobra do app: carregando (enviando/aguardando), falha de comunicacao
 * (sem conexao/sem resposta) e resultado da operacao.
 */
@Composable
private fun CartaoFalha(estado: EstadoVaso?, pedido: Pedido?, conectado: Boolean, acoes: AcoesPainel) {
    val emCurso = pedido is Pedido.Enviando || pedido is Pedido.Aguardando
    val pendente = estado?.falhaPendente == true
    CartaoSecao(
        if (pendente) "Falha aguardando você" else "Reconhecimento de falha",
        if (pendente) Icones.Alerta else Icones.Mao,
        sinal = if (pendente) Sinal.ERRO else Sinal.INFO,
        containerColor = if (pendente) Sinal.ERRO.fundo() else MaterialTheme.colorScheme.surfaceContainerLowest
    ) {
        if (pendente) estado?.let { e ->
            // Servico antigo sem falhasPendentes: cai no bloqueio efetivo, como antes.
            val irrigacao = "IRRIGACAO" in e.falhasPendentes || (e.falhasPendentes.isEmpty() && e.adubacaoEstado != "BLOQUEADA")
            val adubacao = "ADUBACAO" in e.falhasPendentes || e.adubacaoEstado == "BLOQUEADA"
            if (irrigacao) ItemFalha(Icones.Bomba, "A última irrigação não teve efeito (bomba sem fluxo?). A irrigação automática está bloqueada.")
            if (adubacao) ItemFalha(Icones.Frasco, "A última dose de fertilizante não teve efeito. A adubação está bloqueada.")
            if (e.irrigacaoBloqueada && e.irrigacaoMotivo != "irrigacao_bloqueada_sem_efeito") {
                ItemFalha(
                    Icones.Erro,
                    "Além disso, a irrigação está bloqueada por ${Rotulos.motivoBloqueio(e.irrigacaoMotivo)} — isso não se resolve reconhecendo."
                )
            }
            Text(
                "Confira a bomba e os reservatórios. Reconhecer libera as regras bloqueadas; o serviço volta a decidir sozinho.",
                style = MaterialTheme.typography.bodySmall, color = CINZA
            )
        }
        when (pedido) {
            null -> Unit
            is Pedido.Enviando -> Indicador(AZUL, "Enviando pedido…", carregando = true)
            is Pedido.Aguardando -> Indicador(AZUL, "Aguardando resposta do serviço…", carregando = true)
            is Pedido.FalhaEnvio -> {
                Indicador(VERMELHO, "Pedido não enviado")
                Text(pedido.motivo, style = MaterialTheme.typography.bodySmall)
            }
            is Pedido.SemResposta -> {
                Indicador(VERMELHO, "O serviço não respondeu")
                Text(
                    "Tentar de novo reenvia o MESMO pedido: se o primeiro chegou, o efeito não se repete.",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            is Pedido.Concluido -> {
                val r = Rotulos.resultado(pedido.resposta)
                val sinal = when (r.tom) {
                    Rotulos.Tom.SUCESSO -> Sinal.OK
                    Rotulos.Tom.INFO -> Sinal.INFO
                    Rotulos.Tom.ERRO -> Sinal.ERRO
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(sinal.icone(), null, tint = sinal.cor(), modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(r.titulo, style = MaterialTheme.typography.titleSmall)
                }
                if (r.detalhe.isNotEmpty()) Text(r.detalhe, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val falhouComunicacao = pedido is Pedido.SemResposta || pedido is Pedido.FalhaEnvio
            if (pendente || falhouComunicacao) {
                Button(onClick = acoes.reconhecerFalha, enabled = conectado && !emCurso) {
                    Icon(if (falhouComunicacao) Icones.Atualizar else Icones.Certo, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (falhouComunicacao) "Tentar de novo" else "Reconhecer falha")
                }
            }
            if (pedido != null && !emCurso) {
                OutlinedButton(onClick = acoes.dispensarPedido) { Text("OK") }
            }
        }
        if (!conectado && (pendente || pedido != null)) {
            Text("Sem conexão com o broker.", style = MaterialTheme.typography.bodySmall, color = CINZA)
        }
    }
}

@Composable
private fun ItemFalha(icone: ImageVector, texto: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icone, null, tint = VERMELHO, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(texto, style = MaterialTheme.typography.bodyMedium)
    }
}

// -----------------------------------------------------------------------------
// Cartoes de detalhe
// -----------------------------------------------------------------------------

private fun pct(v: Double?) = v?.let { "%.0f%%".format(it) } ?: "—"

@Composable
private fun CartaoReservatorios(e: EstadoVaso) {
    CartaoSecao("Reservatórios", Icones.Reservatorio, corIcone = AZUL, fundoIcone = Sinal.INFO.fundo()) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(Triple("AGUA", "Água", Icones.Gota), Triple("ADUBO", "Fertilizante", Icones.Frasco)).forEach { (chave, nome, icone) ->
                val r = e.reservatorios[chave]
                val sinal = when (r?.estado) {
                    "OK" -> Sinal.OK
                    "BAIXO" -> Sinal.ATENCAO
                    "CRITICO", "INVALIDO" -> Sinal.ERRO
                    else -> Sinal.NEUTRO
                }
                Column(
                    Modifier
                        .weight(1f)
                        .clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(icone, null, tint = sinal.cor(), modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(nome, style = MaterialTheme.typography.labelLarge, color = CINZA)
                    }
                    Text(pct(r?.nivelPct), style = MaterialTheme.typography.headlineSmall)
                    BarraNivel(((r?.nivelPct ?: 0.0) / 100.0).toFloat(), sinal.cor())
                    Text(r?.let { Rotulos.estadoNivel(it.estado) } ?: "Sem leitura", style = MaterialTheme.typography.labelMedium, color = sinal.cor())
                }
            }
        }
    }
}

@Composable
private fun CartaoSolo(e: EstadoVaso) {
    CartaoSecao("Solo e irrigação", Icones.Broto) {
        Linha(
            "Situação", Rotulos.estadoSolo(e.soloEstado),
            if (e.soloEstado in SOLO_COM_PROBLEMA) VERMELHO else null, Icones.Info
        )
        Linha("Bomba de água", if (e.bombaLigada) "Irrigando" else "Desligada", if (e.bombaLigada) AZUL else null, Icones.Bomba)
        Linha(
            "Irrigação automática", if (e.irrigacaoBloqueada) "Bloqueada" else "Liberada",
            if (e.irrigacaoBloqueada) VERMELHO else VERDE, if (e.irrigacaoBloqueada) Icones.Cadeado else Icones.Certo
        )
        if (e.irrigacaoBloqueada) Aviso("Motivo: ${Rotulos.motivoBloqueio(e.irrigacaoMotivo)}.", Sinal.ERRO)
    }
}

@Composable
private fun CartaoAr(e: EstadoVaso) {
    CartaoSecao("Ar", Icones.Vento, corIcone = AZUL, fundoIcone = Sinal.INFO.fundo()) {
        Linha("Umidade (média)", pct(e.arUmidadePct), icone = Icones.Gota)
        Linha("Temperatura", e.arTemperaturaC?.let { "%.1f °C".format(it) } ?: "—", icone = Icones.Termometro)
        Linha("Situação", Rotulos.estadoAr(e.arEstado), if (e.arEstado == "INVALIDO") VERMELHO else null, Icones.Info)
        Linha("Umidificador", if (e.umidificadorLigado) "Ligado" else "Desligado", if (e.umidificadorLigado) AZUL else null, Icones.Vento)
    }
}

@Composable
private fun CartaoAdubacao(e: EstadoVaso) {
    CartaoSecao("Nutrientes", Icones.Frasco, sinal = if (e.excessoNutrientes || e.adubacaoEstado == "BLOQUEADA") Sinal.ERRO else null) {
        Linha(
            "Condutividade (EC25)", e.ec25UsCm?.let { "%.0f µS/cm".format(it) } ?: "—",
            if (e.excessoNutrientes) VERMELHO else null, Icones.Raio
        )
        Linha("Adubação", Rotulos.estadoAdubacao(e.adubacaoEstado), if (e.adubacaoEstado == "BLOQUEADA") VERMELHO else null, Icones.Broto)
        Linha("Doses na janela", "${e.dosesNaJanela}", icone = Icones.Frasco)
        if (e.excessoNutrientes) Aviso("Excesso de nutrientes: regar com água pura.", Sinal.ERRO)
    }
}

/**
 * O celular como SENSOR: mede a luz onde esta (ao lado da planta) e publica
 * LeituraLuz. A conclusao (pouca luz, luz excessiva) e do servico, pela regra
 * R5 com media e tempo minimo -- o app so mostra.
 */
@Composable
private fun CartaoLuz(luz: DadosLuz, estado: EstadoVaso?, agora: Long, conectado: Boolean, alternar: (Boolean) -> Unit) {
    CartaoSecao(
        "Luz · sensor do celular", Icones.Sol,
        corIcone = MaterialTheme.colorScheme.tertiary, fundoIcone = MaterialTheme.colorScheme.tertiaryContainer,
        acao = { if (luz.disponivel) Switch(checked = luz.medir, onCheckedChange = alternar) }
    ) {
        if (!luz.disponivel) {
            Text("Este aparelho não tem sensor de luz.", color = CINZA)
            return@CartaoSecao
        }
        if (!luz.medir) {
            Text("Medição pausada. Ligue para o celular voltar a medir a luz.", color = CINZA, style = MaterialTheme.typography.bodyMedium)
        } else {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(luz.local.luxAtual?.let { "%.0f".format(it) } ?: "—", style = MaterialTheme.typography.displaySmall)
                Spacer(Modifier.width(8.dp))
                Text("lux agora", style = MaterialTheme.typography.bodyMedium, color = CINZA, modifier = Modifier.padding(bottom = 6.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icones.Celular, null, tint = CINZA, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("Deixe o celular ao lado da planta, com a tela para cima.", style = MaterialTheme.typography.bodySmall, color = CINZA)
            }
            val publicado = luz.local.ultimaPublicacaoMs?.let {
                "${luz.local.publicadas} leituras publicadas · última há ${duracao(agora - it)}"
            } ?: if (conectado) "Publicando a cada 5 s…" else "Aguardando conexão para publicar."
            Text(publicado, style = MaterialTheme.typography.bodySmall, color = CINZA)
            luz.local.aviso?.let { Aviso(it, Sinal.ATENCAO) }
        }
        estado?.luz?.let { l ->
            val cor = when (l.estado) {
                "ADEQUADA" -> VERDE
                "POUCA_LUZ", "LUZ_EXCESSIVA" -> AMARELO
                else -> CINZA
            }
            Linha("Avaliação do serviço", Rotulos.estadoLuz(l.estado) + (l.luxMedia?.let { " · média $it lux" } ?: ""), cor, Icones.Certo)
        }
    }
}

@Composable
private fun CartaoDispositivo(dispositivo: EstadoConectividade?, conectado: Boolean, publico: Boolean, estado: EstadoVaso?) {
    if (publico) {
        // No broker publico o sinal de vida do ESP32 nao e verificavel pelo app
        // (vem assinado com a chave do dispositivo); quem o confere e o servico,
        // e o resultado chega no EstadoVaso assinado.
        val offline = estado?.soloEstado == "DISPOSITIVO_OFFLINE"
        CartaoSecao("Dispositivo do vaso", Icones.Chip, acao = {
            when {
                !conectado || estado == null -> Pilula("Sem notícia", Sinal.NEUTRO, icone = Icones.Relogio)
                offline -> Pilula("Offline", Sinal.ERRO, icone = Icones.Erro)
                else -> Pilula("Respondendo", Sinal.OK)
            }
        }) {
            Text(
                "No broker público, quem confere o sinal de vida do ESP32 é o serviço (pelo HMAC do dispositivo). " +
                    "O app mostra o que o serviço concluiu, numa mensagem assinada por ele.",
                style = MaterialTheme.typography.bodySmall, color = CINZA
            )
        }
        return
    }
    CartaoSecao("Dispositivo do vaso", Icones.Chip, acao = {
        when {
            !conectado -> Pilula("Sem broker", Sinal.NEUTRO, icone = Icones.Wifi)
            dispositivo == null -> Pilula("Sem notícia", Sinal.NEUTRO, icone = Icones.Relogio)
            dispositivo.state == "ATIVO" -> Pilula("Online", Sinal.OK)
            dispositivo.state == "SILENCIOSO" -> Pilula("Silencioso", Sinal.ATENCAO, icone = Icones.Relogio)
            else -> Pilula("Offline", Sinal.ERRO, icone = Icones.Erro)
        }
    }) {
        if (dispositivo != null && conectado) {
            Linha("Identificador", dispositivo.deviceId, icone = Icones.Chip)
            dispositivo.reason?.let { Linha("Motivo", it, VERMELHO, Icones.Info) }
        } else {
            Text(
                if (!conectado) "Sem conexão com o broker." else "Ainda não chegou o sinal de vida do dispositivo.",
                style = MaterialTheme.typography.bodySmall, color = CINZA
            )
        }
    }
}

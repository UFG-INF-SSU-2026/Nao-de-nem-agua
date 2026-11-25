package br.ufg.naodenemagua.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.ui.theme.LocalCoresStatus
import kotlinx.coroutines.delay

// -----------------------------------------------------------------------------
// Cores de significado (seguem o tema claro/escuro)
// -----------------------------------------------------------------------------

internal val VERDE: Color @Composable @ReadOnlyComposable get() = LocalCoresStatus.current.ok
internal val AMARELO: Color @Composable @ReadOnlyComposable get() = LocalCoresStatus.current.atencao
internal val VERMELHO: Color @Composable @ReadOnlyComposable get() = LocalCoresStatus.current.erro
internal val AZUL: Color @Composable @ReadOnlyComposable get() = LocalCoresStatus.current.info
internal val CINZA: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurfaceVariant

/** O "tom" de uma informacao: decide cor do texto, do icone e do fundo. */
enum class Sinal { OK, ATENCAO, ERRO, INFO, NEUTRO }

@Composable
@ReadOnlyComposable
internal fun Sinal.cor(): Color = with(LocalCoresStatus.current) {
    when (this@cor) {
        Sinal.OK -> ok
        Sinal.ATENCAO -> atencao
        Sinal.ERRO -> erro
        Sinal.INFO -> info
        Sinal.NEUTRO -> neutro
    }
}

@Composable
@ReadOnlyComposable
internal fun Sinal.fundo(): Color = with(LocalCoresStatus.current) {
    when (this@fundo) {
        Sinal.OK -> okFundo
        Sinal.ATENCAO -> atencaoFundo
        Sinal.ERRO -> erroFundo
        Sinal.INFO -> infoFundo
        Sinal.NEUTRO -> neutroFundo
    }
}

/** Icone de cada tipo de alerta do contrato (codigo novo cai no sino). */
internal fun iconeAlerta(tipo: String): ImageVector = when {
    tipo == "SOLO_SECO" -> Icones.Broto
    tipo == "FALHA_IRRIGACAO" -> Icones.Bomba
    tipo.startsWith("IRRIGACAO") -> Icones.Gota
    tipo == "DADO_OBSOLETO" -> Icones.Relogio
    tipo.startsWith("DISPOSITIVO") -> Icones.Chip
    tipo.startsWith("RESERVATORIO") -> Icones.Reservatorio
    tipo.startsWith("SENSOR") -> Icones.Termometro
    tipo.startsWith("UMIDIFICADOR") -> Icones.Vento
    tipo.contains("ADUBACAO") || tipo == "EXCESSO_NUTRIENTES" -> Icones.Frasco
    tipo.startsWith("LUZ") -> Icones.Sol
    tipo == "ATUACAO_RECUSADA" -> Icones.Erro
    else -> Icones.Sino
}

internal fun sinalSeveridade(severidade: String): Sinal = when (severidade) {
    "CRITICO" -> Sinal.ERRO
    "ATENCAO" -> Sinal.ATENCAO
    else -> Sinal.INFO
}

internal fun Sinal.icone(): ImageVector = when (this) {
    Sinal.OK -> Icones.Certo
    Sinal.ATENCAO -> Icones.Alerta
    Sinal.ERRO -> Icones.Erro
    Sinal.INFO -> Icones.Info
    Sinal.NEUTRO -> Icones.Relogio
}

// -----------------------------------------------------------------------------
// Tempo
// -----------------------------------------------------------------------------

/** Relogio da tela: idades ("ha 3 s"), validade de alertas e "servico parado" dependem do tempo. */
@Composable
internal fun agoraMs(): Long {
    var agora by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            agora = System.currentTimeMillis()
        }
    }
    return agora
}

internal fun duracao(ms: Long): String {
    val s = (ms.coerceAtLeast(0) / 1000)
    return when {
        s < 60 -> "$s s"
        s < 3600 -> "${s / 60} min"
        s < 172_800 -> "${s / 3600} h"
        else -> "${s / 86_400} dias"
    }
}

// -----------------------------------------------------------------------------
// Blocos de tela
// -----------------------------------------------------------------------------

/** Icone dentro de um circulo de fundo suave. */
@Composable
internal fun IconeRedondo(icone: ImageVector, cor: Color, fundo: Color, tamanho: Dp = 36.dp) {
    Box(
        Modifier.size(tamanho).clip(CircleShape).background(fundo),
        contentAlignment = Alignment.Center
    ) {
        Icon(icone, contentDescription = null, tint = cor, modifier = Modifier.size(tamanho * 0.55f))
    }
}

/**
 * Cartao padrao das telas: cabecalho com icone e titulo, um espaco opcional a
 * direita (switch, botao) e o conteudo.
 */
@Composable
internal fun CartaoSecao(
    titulo: String,
    icone: ImageVector,
    modifier: Modifier = Modifier,
    sinal: Sinal? = null,
    containerColor: Color = MaterialTheme.colorScheme.surfaceContainerLowest,
    corIcone: Color = sinal?.cor() ?: MaterialTheme.colorScheme.primary,
    fundoIcone: Color = sinal?.fundo() ?: MaterialTheme.colorScheme.primaryContainer,
    acao: @Composable RowScope.() -> Unit = {},
    conteudo: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = containerColor),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.5.dp)
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconeRedondo(icone, corIcone, fundoIcone, 34.dp)
                Spacer(Modifier.width(12.dp))
                Text(titulo, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                acao()
            }
            conteudo()
        }
    }
}

/** Etiqueta arredondada de estado ("Conectado", "Crítico"...). */
@Composable
internal fun Pilula(texto: String, sinal: Sinal, modifier: Modifier = Modifier, icone: ImageVector? = null, carregando: Boolean = false) {
    Row(
        modifier
            .clip(RoundedCornerShape(50))
            .background(sinal.fundo())
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        when {
            carregando -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.6.dp, color = sinal.cor())
            icone != null -> Icon(icone, null, tint = sinal.cor(), modifier = Modifier.size(14.dp))
            else -> PontoPulsante(sinal.cor(), pulsar = sinal == Sinal.OK, tamanho = 8.dp)
        }
        Spacer(Modifier.width(6.dp))
        Text(texto, style = MaterialTheme.typography.labelMedium, color = sinal.cor())
    }
}

/** Bolinha de estado; "viva" (pulsando) quando a informacao e atual. */
@Composable
internal fun PontoPulsante(cor: Color, pulsar: Boolean, tamanho: Dp = 10.dp) {
    val escala = if (pulsar) {
        val t = rememberInfiniteTransition(label = "pulso")
        t.animateFloat(1f, 1.9f, infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart), label = "escala").value
    } else 1f
    Box(Modifier.size(tamanho * 2), contentAlignment = Alignment.Center) {
        if (pulsar) {
            Box(Modifier.size(tamanho).scale(escala).clip(CircleShape).background(cor.copy(alpha = (1.9f - escala) / 2f)))
        }
        Box(Modifier.size(tamanho).clip(CircleShape).background(cor))
    }
}

@Composable
internal fun Indicador(cor: Color, texto: String, carregando: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (carregando) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = cor)
        else Box(Modifier.size(12.dp).clip(CircleShape).background(cor))
        Spacer(Modifier.width(10.dp))
        Text(texto, style = MaterialTheme.typography.titleSmall)
    }
}

@Composable
internal fun Rotulo(texto: String, modifier: Modifier = Modifier) {
    Text(texto.uppercase(), style = MaterialTheme.typography.labelMedium, color = CINZA, modifier = modifier)
}

/** Uma linha "nome ......... valor", com icone opcional a esquerda. */
@Composable
internal fun Linha(nome: String, valor: String, destaque: Color? = null, icone: ImageVector? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (icone != null) {
            Icon(icone, null, tint = CINZA, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(nome, style = MaterialTheme.typography.bodyMedium, color = CINZA, modifier = Modifier.weight(1f))
        Text(
            valor,
            style = MaterialTheme.typography.bodyMedium,
            color = destaque ?: MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.End
        )
    }
}

/** Faixa de aviso dentro de um cartao (texto com icone, fundo do tom). */
@Composable
internal fun Aviso(texto: String, sinal: Sinal, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).background(sinal.fundo()).padding(12.dp),
        verticalAlignment = Alignment.Top
    ) {
        Icon(sinal.icone(), null, tint = sinal.cor(), modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(texto, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** Barra de nivel grossa e arredondada, animada quando o valor muda. */
@Composable
internal fun BarraNivel(fracao: Float, cor: Color, modifier: Modifier = Modifier, altura: Dp = 10.dp) {
    val f by animateFloatAsState(fracao.coerceIn(0f, 1f), tween(700), label = "nivel")
    Box(
        modifier.fillMaxWidth().height(altura).clip(RoundedCornerShape(50))
            .background(cor.copy(alpha = 0.16f))
    ) {
        Box(Modifier.fillMaxWidth(f).height(altura).clip(RoundedCornerShape(50)).background(cor))
    }
}

/** Anel de progresso (umidade do solo, por exemplo), com conteudo no centro. */
@Composable
internal fun Medidor(
    fracao: Float?,
    cor: Color,
    modifier: Modifier = Modifier,
    tamanho: Dp = 120.dp,
    espessura: Dp = 12.dp,
    conteudo: @Composable () -> Unit
) {
    val f by animateFloatAsState((fracao ?: 0f).coerceIn(0f, 1f), tween(900), label = "medidor")
    val trilho = cor.copy(alpha = 0.15f)
    Box(modifier.size(tamanho), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val e = espessura.toPx()
            val arco = Size(size.width - e, size.height - e)
            val origem = Offset(e / 2, e / 2)
            drawArc(trilho, 135f, 270f, false, origem, arco, style = Stroke(e, cap = StrokeCap.Round))
            if (fracao != null && f > 0f) {
                drawArc(cor, 135f, 270f * f, false, origem, arco, style = Stroke(e, cap = StrokeCap.Round))
            }
        }
        conteudo()
    }
}

/** Tela/area sem conteudo: ilustracao, titulo, explicacao e acao opcional. */
@Composable
internal fun EstadoVazio(
    icone: ImageVector,
    titulo: String,
    texto: String,
    modifier: Modifier = Modifier,
    acao: (@Composable () -> Unit)? = null
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Box(
            Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icone, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(44.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(titulo, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(texto, style = MaterialTheme.typography.bodyMedium, color = CINZA, textAlign = TextAlign.Center)
        if (acao != null) {
            Spacer(Modifier.height(6.dp))
            acao()
        }
    }
}

package br.ufg.naodenemagua.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.contrato.AlertaRegistrado
import br.ufg.naodenemagua.contrato.HistoricoVaso
import br.ufg.naodenemagua.contrato.Ponto
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val HORA = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
private val DIA_HORA = DateTimeFormatter.ofPattern("dd/MM HH:mm").withZone(ZoneId.systemDefault())

/** Tom de coral para a temperatura (legivel no tema claro e no escuro). */
private val CORAL = Color(0xFFE5734A)

/**
 * Historico do vaso, lido da API (HTTPS) sobre o TimescaleDB. Carrega ao abrir
 * a aba e ao trocar o periodo; os estados sao os que o PDF cobra do app:
 * carregando, falha de comunicacao (com a acao) e resultado.
 */
@Composable
fun HistoricoTela(
    estado: EstadoHistorico,
    periodoHoras: Int,
    agora: Long,
    aoEscolherPeriodo: (Int) -> Unit,
    aoCarregar: () -> Unit,
    modifier: Modifier = Modifier
) {
    LaunchedEffect(Unit) { if (estado is EstadoHistorico.Ocioso) aoCarregar() }
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                listOf(1 to "1 h", 6 to "6 h", 24 to "24 h", 168 to "7 dias").forEach { (h, rotulo) ->
                    FilterChip(
                        selected = periodoHoras == h,
                        onClick = { aoEscolherPeriodo(h) },
                        label = { Text(rotulo) },
                        leadingIcon = if (periodoHoras == h) {
                            { Icon(Icones.Relogio, null, Modifier.size(16.dp)) }
                        } else null
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            FilledTonalIconButton(onClick = aoCarregar, enabled = estado !is EstadoHistorico.Carregando) {
                Icon(Icones.Atualizar, contentDescription = "Atualizar")
            }
        }
        when (estado) {
            EstadoHistorico.Ocioso, is EstadoHistorico.Carregando -> Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator()
                    Text("Consultando o histórico…", color = CINZA)
                }
            }
            is EstadoHistorico.Erro -> EstadoVazio(Icones.Servidor, estado.mensagem, estado.dica) {
                Button(onClick = aoCarregar) {
                    Icon(Icones.Atualizar, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Tentar de novo")
                }
            }
            is EstadoHistorico.Pronto -> Conteudo(estado.historico, estado.alertas, estado.carregadoEmMs, agora)
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun Conteudo(h: HistoricoVaso, alertas: List<AlertaRegistrado>, carregadoEm: Long, agora: Long) {
    Text(
        "${DIA_HORA.format(h.de)} – ${DIA_HORA.format(h.ate)} · um ponto a cada ${h.passoMin} min · consultado há ${duracao(agora - carregadoEm)}",
        style = MaterialTheme.typography.bodySmall, color = CINZA
    )
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Resumo(Icones.Gota, "${h.irrigacoes}", "irrigações", AZUL, Sinal.INFO.fundo(), Modifier.weight(1f))
        Resumo(Icones.Frasco, "${h.dosesAdubo}", "doses de adubo", VERDE, Sinal.OK.fundo(), Modifier.weight(1f))
        Resumo(Icones.Sino, "${h.alertas}", "alertas", AMARELO, Sinal.ATENCAO.fundo(), Modifier.weight(1f))
    }
    if (h.vazio) {
        EstadoVazio(Icones.Grafico, "Sem medições neste período", "Escolha um período maior ou confira se o vaso está publicando.")
    } else {
        Grafico("Umidade do solo", Icones.Broto, h.soloUmidadePct, h, AZUL, "%", 0.0, 100.0)
        Grafico("Umidade do ar", Icones.Vento, h.arUmidadePct, h, MaterialTheme.colorScheme.secondary, "%", 0.0, 100.0)
        Grafico("Temperatura do ar", Icones.Termometro, h.arTemperaturaC, h, CORAL, " °C")
        Grafico("Luz (sensor do celular)", Icones.Sol, h.luzLux, h, MaterialTheme.colorScheme.tertiary, " lux", 0.0)
        Grafico("Reservatório de água", Icones.Reservatorio, h.reservatorioAguaPct, h, VERDE, "%", 0.0, 100.0)
    }
    CartaoSecao("Alertas registrados", Icones.Sino, corIcone = AMARELO, fundoIcone = Sinal.ATENCAO.fundo()) {
        if (alertas.isEmpty()) Text("Nenhum alerta no período.", color = CINZA, style = MaterialTheme.typography.bodyMedium)
        alertas.forEachIndexed { i, a ->
            val sinal = sinalSeveridade(a.severidade)
            Row(verticalAlignment = Alignment.Top) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    IconeRedondo(iconeAlerta(a.tipo), sinal.cor(), sinal.fundo(), 30.dp)
                    if (i < alertas.lastIndex) {
                        Box(Modifier.padding(top = 4.dp).width(2.dp).height(18.dp).background(MaterialTheme.colorScheme.outlineVariant))
                    }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row {
                        Text(Rotulos.tipoAlerta(a.tipo), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        Text(DIA_HORA.format(a.ts), style = MaterialTheme.typography.labelSmall, color = CINZA)
                    }
                    Text(a.mensagem, style = MaterialTheme.typography.bodySmall, color = CINZA)
                }
            }
        }
    }
}

@Composable
private fun Resumo(icone: ImageVector, valor: String, rotulo: String, cor: Color, fundo: Color, modifier: Modifier) {
    Column(
        modifier
            .clip(MaterialTheme.shapes.large)
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        IconeRedondo(icone, cor, fundo, 32.dp)
        Text(valor, style = MaterialTheme.typography.headlineSmall)
        Text(rotulo, style = MaterialTheme.typography.labelSmall, color = CINZA, maxLines = 1)
    }
}

/**
 * Linha do tempo de uma serie, desenhada em Canvas (sem biblioteca). O eixo X
 * e o periodo pedido inteiro; buracos maiores que 3 passos (sem medicao) quebram
 * a linha em vez de ligar dois pontos distantes como se houvesse dado entre eles.
 * Embaixo de cada trecho, um degrade suave da cor da serie.
 */
@Composable
private fun Grafico(
    titulo: String,
    icone: ImageVector,
    pontos: List<Ponto>,
    h: HistoricoVaso,
    cor: Color,
    unidade: String,
    minFixo: Double? = null,
    maxFixo: Double? = null
) {
    CartaoSecao(
        titulo, icone, corIcone = cor, fundoIcone = cor.copy(alpha = 0.15f),
        acao = {
            Text(
                pontos.lastOrNull()?.let { "${formatar(it.v)}$unidade" } ?: "sem dados",
                style = MaterialTheme.typography.titleMedium, color = if (pontos.isEmpty()) CINZA else cor
            )
        }
    ) {
        if (pontos.isEmpty()) return@CartaoSecao
        val minimo = minFixo ?: pontos.minOf { it.v }
        val maximo = maxOf(maxFixo ?: pontos.maxOf { it.v }, minimo + 1.0)
        Row {
            Column(Modifier.height(120.dp).width(40.dp), verticalArrangement = Arrangement.SpaceBetween) {
                Text(formatar(maximo), style = MaterialTheme.typography.labelSmall, color = CINZA)
                Text(formatar(minimo), style = MaterialTheme.typography.labelSmall, color = CINZA)
            }
            val inicio = h.de.toEpochMilli()
            val largura = (h.ate.toEpochMilli() - inicio).coerceAtLeast(1)
            val buraco = 3L * h.passoMin * 60_000
            val grade = MaterialTheme.colorScheme.outlineVariant
            Canvas(Modifier.weight(1f).height(120.dp)) {
                val x = { t: Instant -> ((t.toEpochMilli() - inicio).toFloat() / largura) * size.width }
                val y = { v: Double -> size.height - (((v - minimo) / (maximo - minimo)).toFloat().coerceIn(0f, 1f) * size.height) }
                for (i in 0..2) {
                    val gy = size.height * i / 2f
                    drawLine(grade, Offset(0f, gy), Offset(size.width, gy), 1f,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
                }
                // Trechos continuos; um ponto sozinho entre buracos vira um circulo
                // (uma linha de comprimento zero nao apareceria).
                val trechos = mutableListOf(mutableListOf<Ponto>())
                pontos.forEach { p ->
                    val ultimo = trechos.last().lastOrNull()
                    if (ultimo != null && p.t.toEpochMilli() - ultimo.t.toEpochMilli() > buraco) trechos.add(mutableListOf())
                    trechos.last().add(p)
                }
                val degrade = Brush.verticalGradient(listOf(cor.copy(alpha = 0.28f), cor.copy(alpha = 0f)))
                trechos.filter { it.isNotEmpty() }.forEach { trecho ->
                    if (trecho.size == 1) {
                        drawCircle(cor, 6f, Offset(x(trecho[0].t), y(trecho[0].v)))
                    } else {
                        val linha = Path()
                        trecho.forEachIndexed { i, p -> if (i == 0) linha.moveTo(x(p.t), y(p.v)) else linha.lineTo(x(p.t), y(p.v)) }
                        val area = Path().apply {
                            addPath(linha)
                            lineTo(x(trecho.last().t), size.height)
                            lineTo(x(trecho.first().t), size.height)
                            close()
                        }
                        drawPath(area, degrade)
                        drawPath(linha, cor, style = Stroke(width = 5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }
                }
                // Destaque no ultimo ponto (o valor do canto superior direito).
                pontos.last().let { p ->
                    drawCircle(cor.copy(alpha = 0.25f), 14f, Offset(x(p.t), y(p.v)))
                    drawCircle(cor, 6f, Offset(x(p.t), y(p.v)))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 40.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            val fmt = if (h.horas >= 24) DIA_HORA else HORA
            Text(fmt.format(h.de), style = MaterialTheme.typography.labelSmall, color = CINZA)
            Text(fmt.format(h.ate), style = MaterialTheme.typography.labelSmall, color = CINZA)
        }
    }
}

private fun formatar(v: Double): String = if (v >= 100 || v == Math.floor(v)) "%.0f".format(v) else "%.1f".format(v)

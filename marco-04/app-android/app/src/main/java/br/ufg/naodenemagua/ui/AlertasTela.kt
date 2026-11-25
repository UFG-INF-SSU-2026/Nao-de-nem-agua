package br.ufg.naodenemagua.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp

/**
 * Alertas da sessao (AlertaCuidado, publicados pelo servico em alert/cuidado).
 * O ttlMs do contrato define ate quando o aviso vale: vencido, ele vai para
 * "Anteriores", esmaecido -- aviso velho e historico, nao chamada para agir.
 */
@Composable
fun AlertasTela(alertas: List<AlertaRecebido>, agora: Long, modifier: Modifier = Modifier) {
    if (alertas.isEmpty()) {
        EstadoVazio(
            Icones.Folha,
            "Tudo tranquilo",
            "Nenhum alerta desde que o app conectou. Quando o vaso precisar de algo, o aviso aparece aqui.",
            modifier.fillMaxSize().padding(top = 48.dp)
        )
        return
    }
    val (ativos, anteriores) = alertas.partition { !it.alerta.vencido(agora) }
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        if (ativos.isNotEmpty()) {
            item { Secao("Ativos", ativos.size) }
            items(ativos, key = { it.alerta.eventId }) { CartaoAlerta(it, agora, vencido = false) }
        }
        if (anteriores.isNotEmpty()) {
            item { Secao("Anteriores", anteriores.size) }
            items(anteriores, key = { it.alerta.eventId }) { CartaoAlerta(it, agora, vencido = true) }
        }
    }
}

@Composable
private fun Secao(texto: String, quantidade: Int) {
    Row(Modifier.padding(top = 8.dp, start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Rotulo(texto)
        Spacer(Modifier.width(8.dp))
        Text("$quantidade", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun CartaoAlerta(r: AlertaRecebido, agora: Long, vencido: Boolean) {
    val a = r.alerta
    val sinal = sinalSeveridade(a.severity)
    val severidade = when (a.severity) {
        "CRITICO" -> "Crítico"
        "ATENCAO" -> "Atenção"
        else -> "Informação"
    }
    Card(
        Modifier.fillMaxWidth().alpha(if (vencido) 0.6f else 1f),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.5.dp)
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            IconeRedondo(iconeAlerta(a.alertType), sinal.cor(), sinal.fundo(), 42.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(Rotulos.tipoAlerta(a.alertType), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Pilula(severidade, sinal, icone = sinal.icone())
                }
                Text(a.message, style = MaterialTheme.typography.bodyMedium)
                val restante = a.issuedAt.toEpochMilli() + a.ttlMs - agora
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icones.Relogio, null, tint = CINZA, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "há ${duracao(agora - a.issuedAt.toEpochMilli())} · " +
                            if (vencido) "vencido" else "vale por mais ${duracao(restante)}",
                        style = MaterialTheme.typography.bodySmall, color = CINZA
                    )
                }
            }
        }
    }
}

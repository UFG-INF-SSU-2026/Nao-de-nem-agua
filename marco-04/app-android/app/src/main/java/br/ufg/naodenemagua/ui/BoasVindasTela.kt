package br.ufg.naodenemagua.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.ui.theme.MarcaAgua
import br.ufg.naodenemagua.ui.theme.MarcaTeal
import br.ufg.naodenemagua.ui.theme.MarcaVerde
import kotlinx.coroutines.launch

private data class Pagina(
    val titulo: String,
    val texto: String,
    val principal: ImageVector?,
    val satelites: List<Pair<ImageVector, Sinal>>
)

private val PAGINAS = listOf(
    Pagina(
        "Seu vaso cuida de si",
        "Sensores medem o solo, o ar e os reservatórios. O serviço decide sozinho quando irrigar e quando adubar — você só acompanha.",
        null,
        listOf(Icones.Gota to Sinal.INFO, Icones.Termometro to Sinal.ATENCAO, Icones.Frasco to Sinal.OK)
    ),
    Pagina(
        "Seu celular vira sensor",
        "Deixe o celular ao lado da planta, com a tela para cima: ele mede a luz do ambiente e o serviço avisa se está pouca ou demais.",
        Icones.Sol,
        listOf(Icones.Celular to Sinal.INFO, Icones.Folha to Sinal.OK)
    ),
    Pagina(
        "Avisos na hora certa",
        "Solo seco, reservatório baixo, bomba sem fluxo: os alertas chegam na hora, e a conexão é protegida com TLS e a CA do grupo.",
        Icones.Sino,
        listOf(Icones.Escudo to Sinal.OK, Icones.Alerta to Sinal.ATENCAO)
    )
)

/** Apresentacao do app na primeira abertura (tres paginas, com "Pular"). */
@Composable
fun BoasVindasTela(aoConcluir: () -> Unit) {
    val pager = rememberPagerState { PAGINAS.size }
    val escopo = rememberCoroutineScope()
    val ultima = pager.currentPage == PAGINAS.lastIndex

    Column(Modifier.fillMaxSize().systemBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.End) {
            if (ultima) Spacer(Modifier.height(48.dp))
            else TextButton(onClick = aoConcluir) { Text("Pular") }
        }
        HorizontalPager(pager, Modifier.weight(1f)) { i ->
            val p = PAGINAS[i]
            Column(
                Modifier.fillMaxSize().padding(horizontal = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Ilustracao(p)
                Spacer(Modifier.height(40.dp))
                Text(p.titulo, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Text(
                    p.texto,
                    style = MaterialTheme.typography.bodyLarge,
                    color = CINZA,
                    textAlign = TextAlign.Center
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(24.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                repeat(PAGINAS.size) { i ->
                    val ativo = pager.currentPage == i
                    val largura by animateDpAsState(if (ativo) 24.dp else 8.dp, label = "ponto")
                    val cor by animateColorAsState(
                        if (ativo) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                        label = "cor"
                    )
                    Box(Modifier.height(8.dp).width(largura).clip(RoundedCornerShape(50)).background(cor))
                }
            }
            Button(
                onClick = { if (ultima) aoConcluir() else escopo.launch { pager.animateScrollToPage(pager.currentPage + 1) } },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp)
            ) {
                Text(if (ultima) "Começar" else "Próximo")
                Spacer(Modifier.width(6.dp))
                Icon(Icones.Seta, null, Modifier.size(18.dp))
            }
        }
    }
}

/** Circulo com degrade da marca, o icone da pagina e "satelites" em volta. */
@Composable
private fun Ilustracao(p: Pagina) {
    Box(Modifier.size(260.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(200.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f))
        )
        Box(
            Modifier.size(150.dp).shadow(12.dp, CircleShape).clip(CircleShape)
                .background(Brush.linearGradient(listOf(MarcaVerde, MarcaTeal, MarcaAgua))),
            contentAlignment = Alignment.Center
        ) {
            if (p.principal == null) Image(Icones.Logo, null, Modifier.size(96.dp))
            else Icon(p.principal, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(72.dp))
        }
        val posicoes = listOf((-96).dp to (-70).dp, 98.dp to (-30).dp, (-70).dp to 92.dp)
        p.satelites.forEachIndexed { i, (icone, sinal) ->
            val (x, y) = posicoes[i % posicoes.size]
            Box(
                Modifier.offset(x, y).shadow(6.dp, CircleShape).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceContainerLowest).padding(6.dp)
            ) {
                IconeRedondo(icone, sinal.cor(), sinal.fundo(), 40.dp)
            }
        }
    }
}

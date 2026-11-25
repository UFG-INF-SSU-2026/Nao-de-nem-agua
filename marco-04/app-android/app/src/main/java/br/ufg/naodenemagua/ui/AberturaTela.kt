package br.ufg.naodenemagua.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.ui.theme.MarcaAgua
import br.ufg.naodenemagua.ui.theme.MarcaTeal
import br.ufg.naodenemagua.ui.theme.MarcaVerde

/** Enquanto as preferencias sao lidas: a marca, com a gota "flutuando". */
@Composable
fun AberturaTela() {
    val t = rememberInfiniteTransition(label = "abertura")
    val y = t.animateFloat(0f, -10f, infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "y")
    Box(
        Modifier.fillMaxSize().background(Brush.linearGradient(listOf(MarcaVerde, MarcaTeal, MarcaAgua))),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Image(Icones.Logo, contentDescription = null, modifier = Modifier.size(120.dp).offset(y = y.value.dp))
            Spacer(Modifier.height(24.dp))
            Text("Não dê nem água", style = MaterialTheme.typography.headlineMedium, color = Color.White)
            Text("seu vaso cuida de si — você acompanha", style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.85f))
            Spacer(Modifier.height(28.dp))
            LinearProgressIndicator(
                Modifier.width(120.dp),
                color = Color.White,
                trackColor = Color.White.copy(alpha = 0.25f)
            )
        }
    }
}

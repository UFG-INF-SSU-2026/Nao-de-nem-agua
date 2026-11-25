package br.ufg.naodenemagua.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val Claro = lightColorScheme(
    primary = Folha40,
    onPrimary = Color.White,
    primaryContainer = Folha90,
    onPrimaryContainer = Folha10,
    secondary = Agua40,
    onSecondary = Color.White,
    secondaryContainer = Agua90,
    onSecondaryContainer = Agua10,
    tertiary = Sol40,
    onTertiary = Color.White,
    tertiaryContainer = Sol90,
    onTertiaryContainer = Sol10,
    background = FundoClaro,
    onBackground = TextoClaro,
    surface = FundoClaro,
    onSurface = TextoClaro,
    surfaceVariant = Color(0xFFDCE5DE),
    onSurfaceVariant = TextoSuaveClaro,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFBFDFB),
    surfaceContainer = Color(0xFFEDF3EE),
    surfaceContainerHigh = Color(0xFFE6EEE8),
    surfaceContainerHighest = Color(0xFFDFE8E2),
    outline = Color(0xFF717B75),
    outlineVariant = Color(0xFFC6D1CA)
)

private val Escuro = darkColorScheme(
    primary = Folha80,
    onPrimary = Folha20,
    primaryContainer = Folha30,
    onPrimaryContainer = Folha90,
    secondary = Agua80,
    onSecondary = Agua20,
    secondaryContainer = Agua30,
    onSecondaryContainer = Agua90,
    tertiary = Sol80,
    onTertiary = Sol20,
    tertiaryContainer = Sol30,
    onTertiaryContainer = Sol90,
    background = FundoEscuro,
    onBackground = TextoEscuro,
    surface = FundoEscuro,
    onSurface = TextoEscuro,
    surfaceVariant = Color(0xFF3A4741),
    onSurfaceVariant = TextoSuaveEscuro,
    surfaceContainerLowest = Color(0xFF09130F),
    surfaceContainerLow = Color(0xFF14221D),
    surfaceContainer = Color(0xFF182722),
    surfaceContainerHigh = Color(0xFF20302A),
    surfaceContainerHighest = Color(0xFF2A3B34),
    outline = Color(0xFF8A968F),
    outlineVariant = Color(0xFF34423C)
)

/**
 * Cores de SIGNIFICADO (ok, atencao, erro, informacao, neutro), separadas das
 * cores da marca: um estado critico tem de parecer critico em qualquer tema.
 * Cada uma tem a versao "forte" (texto, icone, barra) e um fundo suave.
 */
@Immutable
data class CoresStatus(
    val ok: Color,
    val okFundo: Color,
    val atencao: Color,
    val atencaoFundo: Color,
    val erro: Color,
    val erroFundo: Color,
    val info: Color,
    val infoFundo: Color,
    val neutro: Color,
    val neutroFundo: Color
)

private val StatusClaro = CoresStatus(
    ok = Color(0xFF1E8A50), okFundo = Color(0xFFDDF3E5),
    atencao = Color(0xFFB26A00), atencaoFundo = Color(0xFFFFEFD2),
    erro = Color(0xFFC62E2E), erroFundo = Color(0xFFFDE3E1),
    info = Color(0xFF1D6FA3), infoFundo = Color(0xFFDCEEFB),
    neutro = Color(0xFF6B756F), neutroFundo = Color(0xFFE6ECE8)
)

private val StatusEscuro = CoresStatus(
    ok = Color(0xFF6FD69A), okFundo = Color(0xFF173A28),
    atencao = Color(0xFFF2B95A), atencaoFundo = Color(0xFF3D2E12),
    erro = Color(0xFFFF8A80), erroFundo = Color(0xFF4A1C1A),
    info = Color(0xFF8CC8F5), infoFundo = Color(0xFF143349),
    neutro = Color(0xFF9AA7A0), neutroFundo = Color(0xFF26332E)
)

val LocalCoresStatus = staticCompositionLocalOf { StatusClaro }

private val Formas = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(32.dp)
)

/**
 * Tema do app. A cor dinamica (Material You) fica desligada de proposito: a
 * paleta folha/agua e parte da identidade e das leituras de estado.
 */
@Composable
fun NaoDeNemAguaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    CompositionLocalProvider(LocalCoresStatus provides if (darkTheme) StatusEscuro else StatusClaro) {
        MaterialTheme(
            colorScheme = if (darkTheme) Escuro else Claro,
            typography = Typography,
            shapes = Formas,
            content = content
        )
    }
}

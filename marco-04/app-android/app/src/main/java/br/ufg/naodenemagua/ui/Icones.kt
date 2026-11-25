package br.ufg.naodenemagua.ui

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Icones proprios do app, em traco (24x24, linha de 2, pontas redondas), no
 * mesmo estilo da marca. Ficam no codigo -- sem biblioteca de icones -- e sao
 * coloridos pelo `tint` do Icon, como qualquer icone do Material.
 */
object Icones {

    val Gota = traco("gota", "M12 2.8C12 2.8 5.5 9.8 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9.8 12 2.8 12 2.8Z")

    val Folha = traco(
        "folha",
        "M5 19C5 10.5 10 5 20 4c-.5 10-5.5 15-15 15Z",
        "M5 19l8.5-8.5"
    )

    val Broto = traco(
        "broto",
        "M12 21v-9",
        "M12 12C12 8 9.5 5.5 5 5.5 5 9.5 7.5 12 12 12Z",
        "M12 14.5c0-4 2.5-6.5 7-6.5 0 4-2.5 6.5-7 6.5Z"
    )

    val Vaso = traco(
        "vaso",
        "M4.5 13h15",
        "M6 13l1.4 8h9.2l1.4-8",
        "M12 13V8.5",
        "M12 8.5C12 5.5 10 3.5 6.5 3.5c0 3 2 5 5.5 5Z",
        "M12 10.5c0-3 2-5 5.5-5 0 3-2 5-5.5 5Z"
    )

    val Sol = traco(
        "sol",
        "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0Z",
        "M12 2.5v2", "M12 19.5v2", "M2.5 12h2", "M19.5 12h2",
        "M5.3 5.3l1.4 1.4", "M17.3 17.3l1.4 1.4", "M5.3 18.7l1.4-1.4", "M17.3 6.7l1.4-1.4"
    )

    val Termometro = traco(
        "termometro",
        "M14 14.6V5a2 2 0 0 0-4 0v9.6a4 4 0 1 0 4 0Z",
        "M12 17.5V11"
    )

    val Vento = traco(
        "vento",
        "M3 8.5h10.5a2.75 2.75 0 1 0-2.75-2.75",
        "M3 12.5h15a3 3 0 1 1-3 3",
        "M3 16.5h6"
    )

    val Reservatorio = traco(
        "reservatorio",
        "M6 3.5h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z",
        "M5 12.5c2.3-1.2 4.7 1.2 7 0s4.7-1.2 7 0"
    )

    val Frasco = traco(
        "frasco",
        "M9 3h6",
        "M10 3v6.2L5 18.6A1.6 1.6 0 0 0 6.4 21h11.2a1.6 1.6 0 0 0 1.4-2.4L14 9.2V3",
        "M7.5 15h9"
    )

    val Raio = traco("raio", "M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z")

    val Bomba = traco(
        "bomba",
        "M4 14h7v6H4z",
        "M11 16h4a3 3 0 0 0 3-3V8",
        "M15.5 8h5",
        "M18 4.5c0 0-1.8 2-1.8 3.1",
        "M7.5 14v-3"
    )

    val Chip = traco(
        "chip",
        "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z",
        "M10 3.5V7", "M14 3.5V7", "M10 17v3.5", "M14 17v3.5",
        "M3.5 10H7", "M3.5 14H7", "M17 10h3.5", "M17 14h3.5"
    )

    val Celular = traco(
        "celular",
        "M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5Z",
        "M11 18h2"
    )

    val Sino = traco(
        "sino",
        "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5Z",
        "M10 21h4"
    )

    val Grafico = traco(
        "grafico",
        "M4 4v16h16",
        "M7.5 15l3.5-4.5 3 3 5-6.5"
    )

    val Ajustes = traco(
        "ajustes",
        "M4 7h9", "M17 7h3", "M4 17h3", "M11 17h9",
        "M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z",
        "M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z"
    )

    val Sair = traco(
        "sair",
        "M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5",
        "M9.5 16.5 5 12l4.5-4.5",
        "M5 12h10.5"
    )

    val Olho = traco(
        "olho",
        "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z",
        "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z"
    )

    val OlhoFechado = traco(
        "olho_fechado",
        "M3.5 3.5l17 17",
        "M10.4 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4",
        "M6.6 6.7C4 8.4 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 5.1-1.5",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2"
    )

    val Servidor = traco(
        "servidor",
        "M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 19 10H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5Z",
        "M5 14h14a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-3.5A1.5 1.5 0 0 1 5 14Z",
        "M7.5 6.75h.01", "M7.5 17.25h.01"
    )

    val Porta = traco(
        "porta",
        "M9 3v5", "M15 3v5",
        "M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8Z",
        "M12 16.5V21"
    )

    val Usuario = traco(
        "usuario",
        "M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0Z",
        "M4.5 20.5a7.5 7.5 0 0 1 15 0"
    )

    val Cadeado = traco(
        "cadeado",
        "M6.5 10.5h11a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5Z",
        "M8 10.5V7a4 4 0 0 1 8 0v3.5",
        "M12 14.5v2"
    )

    val Escudo = traco(
        "escudo",
        "M12 2.8 4.5 5.8v5.7c0 4.6 3.1 8.2 7.5 9.7 4.4-1.5 7.5-5.1 7.5-9.7V5.8L12 2.8Z",
        "M8.8 12l2.2 2.2 4.2-4.4"
    )

    val Wifi = traco(
        "wifi",
        "M2.5 9a14 14 0 0 1 19 0",
        "M5.5 12.4a9.5 9.5 0 0 1 13 0",
        "M8.7 15.7a5 5 0 0 1 6.6 0",
        "M12 19.2h.01"
    )

    val Atualizar = traco(
        "atualizar",
        "M20 12a8 8 0 1 1-2.35-5.65",
        "M20 4.5v5h-5"
    )

    val Alerta = traco(
        "alerta",
        "M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z",
        "M12 9.5v4",
        "M12 17h.01"
    )

    val Info = traco(
        "info",
        "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z",
        "M12 11v5.5",
        "M12 7.8h.01"
    )

    val Certo = traco(
        "certo",
        "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z",
        "M8 12.2l2.8 2.8L16.2 9.5"
    )

    val Erro = traco(
        "erro",
        "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z",
        "M9 9l6 6", "M15 9l-6 6"
    )

    val Relogio = traco(
        "relogio",
        "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z",
        "M12 7v5l3.2 2"
    )

    val Mao = traco(
        "mao",
        "M8 13V5.5a1.5 1.5 0 0 1 3 0V11",
        "M11 10.5V4a1.5 1.5 0 0 1 3 0v7",
        "M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.6-2.2L3.6 15.9a1.5 1.5 0 0 1 2.3-1.9L8 16"
    )

    val Seta = traco("seta", "M9 5.5 15.5 12 9 18.5")

    val Voltar = traco("voltar", "M15 5.5 8.5 12l6.5 6.5")

    val Fechar = traco("fechar", "M6 6l12 12", "M18 6 6 18")

    /**
     * O logo colorido (a mesma gota com broto do icone do app). Para usar com
     * `Image`, nao com `Icon` -- o Icon pintaria tudo de uma cor so.
     */
    val Logo: ImageVector by lazy {
        ImageVector.Builder("logo", 96.dp, 96.dp, 60f, 60f).apply {
            addPath(
                addPathNodes("M30 1C30 1 10 24 10 40c0 11.05 8.95 20 20 20s20-8.95 20-20C50 24 30 1 30 1Z"),
                fill = Brush.verticalGradient(listOf(Color(0xFFF2FBFF), Color(0xFFB5E3F7)), startY = 1f, endY = 60f)
            )
            addPath(
                addPathNodes("M44.5 41.5c0 6-4 11.3-9.5 13.1"),
                stroke = SolidColor(Color.White), strokeLineWidth = 2.6f, strokeLineCap = StrokeCap.Round
            )
            addPath(
                addPathNodes("M21.5 54c3.5-2.2 13.5-2.2 17 0"),
                stroke = SolidColor(Color(0xFF1B6E47)), strokeLineWidth = 2.4f, strokeLineCap = StrokeCap.Round
            )
            addPath(
                addPathNodes("M30 52.5V36"),
                stroke = SolidColor(Color(0xFF1B7A4C)), strokeLineWidth = 3f, strokeLineCap = StrokeCap.Round
            )
            addPath(addPathNodes("M30 43c-7 0-11-4.5-11-12 6.5 0 11 4.5 11 12Z"), fill = SolidColor(Color(0xFF2E9E5E)))
            addPath(addPathNodes("M30 38c0-8 4.5-13 11-13 0 7-4.5 13-11 13Z"), fill = SolidColor(Color(0xFF3DB571)))
        }.build()
    }

    private fun traco(nome: String, vararg caminhos: String): ImageVector =
        ImageVector.Builder(nome, 24.dp, 24.dp, 24f, 24f).apply {
            caminhos.forEach { d ->
                addPath(
                    addPathNodes(d),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round
                )
            }
        }.build()
}

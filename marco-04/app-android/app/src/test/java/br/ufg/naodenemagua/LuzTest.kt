package br.ufg.naodenemagua

import br.ufg.naodenemagua.contrato.Contratos
import br.ufg.naodenemagua.sensor.JanelaLuz
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Janela de amostras do sensor "on-change" e a LeituraLuz que sai do app. */
class LuzTest {

    @Test
    fun janelaFazAMediaDasAmostras() {
        val j = JanelaLuz()
        j.adicionar(100f)
        j.adicionar(300f)
        assertEquals(200.0 to 2, j.fechar())
    }

    @Test
    fun semAmostraNovaRepeteAUltimaComZeroAmostras() {
        // Luz parada: o sensor nao dispara, mas a luz continua valendo.
        val j = JanelaLuz()
        j.adicionar(850f)
        j.fechar()
        assertEquals(850.0 to 0, j.fechar())
    }

    @Test
    fun antesDaPrimeiraLeituraNaoHaOQuePublicar() {
        assertNull(JanelaLuz().fechar())
    }

    @Test
    fun leituraLuzSaiNoContrato() {
        val j = JSONObject(
            Contratos.leituraLuz(
                eventId = "app-vaso-01:ab12cd34:7", deviceId = "app-vaso-01", vasoId = "vaso-01", sequence = 7,
                medidoEm = Instant.parse("2026-11-24T18:00:00Z"), lux = 851.27, amostras = 3,
                janelaMs = 5000, sensor = "TCS3701 Light"
            )
        )
        assertEquals("LeituraLuz", j.getString("eventType"))
        assertEquals(851.3, j.getDouble("lux"), 0.0)
        assertTrue(j.getBoolean("valid"))
        assertTrue(Regex("^[a-zA-Z0-9_-]+:[a-f0-9]{4,16}:[0-9]+$").matches(j.getString("eventId")))
        assertEquals(setOf("schemaVersion", "eventId", "eventType", "deviceId", "entityId", "sequence", "measuredAt",
            "lux", "samples", "windowMs", "sensor", "valid"), j.keys().asSequence().toSet())
    }

    @Test
    fun horarioSaiComNoMaximoMilissegundos() {
        // Bug achado no aparelho: Instant.now() do Android traz microssegundos e o
        // servico recusava a leitura (utc-date-time aceita ate 3 casas).
        val formato = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$""")
        val comMicros = Instant.parse("2026-11-24T21:04:22.935123Z")
        val luz = JSONObject(
            Contratos.leituraLuz("app-vaso-01:ab12cd34:1", "app-vaso-01", "vaso-01", 1, comMicros, 10.0, 1, 5000, "s")
        ).getString("measuredAt")
        assertEquals("2026-11-24T21:04:22.935Z", luz)
        val pedido = JSONObject(
            Contratos.solicitacao("req-12345678", "app-vaso-01", "vaso-01", "RECONHECER_FALHA", comMicros, 30_000)
        ).getString("createdAt")
        assertTrue(formato.matches(pedido))
    }

    @Test
    fun estadoVasoSemLuzContinuaValido() {
        // Servico de antes da R5: o campo e opcional.
        val semLuz = """{"schemaVersion":1,"eventType":"EstadoVaso","producerId":"servico-irrigacao","entityId":"vaso-01",
            "generatedAt":"2026-11-24T18:03:12.512Z","publishIntervalMs":5000,
            "solo":{"estado":"NORMAL","umidadePct":58,"idadeMs":820,"bombaLigada":false,"autorizado":false},
            "ar":{"estado":"NORMAL","umidadePct":61.3,"temperaturaC":24.5,"umidificadorLigado":false},
            "reservatorios":{},"irrigacao":{"bloqueada":false,"motivo":null},
            "adubacao":{"estado":"OCIOSO","ec25UsCm":null,"dosesNaJanela":0,"excesso":false},"falhaPendente":false}"""
        assertNull(Contratos.estadoVaso(semLuz)!!.luz)
        val comLuz = JSONObject(semLuz).put("luz", JSONObject().put("estado", "POUCA_LUZ").put("luxMedia", 12).put("idadeMs", 900))
        val luz = Contratos.estadoVaso(comLuz.toString())!!.luz!!
        assertEquals("POUCA_LUZ", luz.estado)
        assertEquals(12, luz.luxMedia)
        assertFalse(luz.idadeMs == null)
    }
}

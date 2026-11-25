package br.ufg.naodenemagua

import br.ufg.naodenemagua.contrato.Historico
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Respostas da API de historico (HistoricoVaso, HistoricoAlertas) vistas pelo app. */
class HistoricoTest {

    private val serie = """[{"t":"2026-11-24T21:00:00.000Z","v":40},{"t":"2026-11-24T21:05:00.000Z","v":41.5}]"""
    private val historico = """
        {"schemaVersion":1,"eventType":"HistoricoVaso","entityId":"vaso-01","geradoEm":"2026-11-24T22:00:00.000Z",
         "de":"2026-11-23T22:00:00.000Z","ate":"2026-11-24T22:00:00.000Z","horas":24,"passoMin":5,
         "series":{"soloUmidadePct":$serie,"arUmidadePct":[],"arTemperaturaC":[],"luzLux":[],
                   "reservatorioAguaPct":[],"reservatorioAduboPct":[]},
         "resumo":{"irrigacoes":2,"dosesAdubo":1,"alertas":3}}
    """.trimIndent()

    @Test
    fun historicoValidoELido() {
        val h = Historico.vaso(historico)!!
        assertEquals(5, h.passoMin)
        assertEquals(2, h.soloUmidadePct.size)
        assertEquals(41.5, h.soloUmidadePct[1].v, 0.0)
        assertEquals(2, h.irrigacoes)
        assertTrue(!h.vazio)
    }

    @Test
    fun historicoSemSeriesEVazio() {
        val vazio = JSONObject(historico).apply {
            getJSONObject("series").put("soloUmidadePct", org.json.JSONArray())
        }.toString()
        assertTrue(Historico.vaso(vazio)!!.vazio)
    }

    @Test
    fun respostaForaDoContratoERejeitada() {
        assertNull(Historico.vaso(JSONObject(historico).put("schemaVersion", 2).toString()))
        assertNull(Historico.vaso(JSONObject(historico).put("eventType", "HistoricoAlertas").toString()))
        assertNull(Historico.vaso("""{"erro":"NAO_AUTENTICADO","mensagem":"x"}"""))
    }

    @Test
    fun alertasDoBanco() {
        val a = Historico.alertas(
            """{"schemaVersion":1,"eventType":"HistoricoAlertas","entityId":"vaso-01","geradoEm":"2026-11-24T22:00:00.000Z",
                "horas":168,"alertas":[{"ts":"2026-11-24T21:07:41.824Z","tipo":"LUZ_INSUFICIENTE","severidade":"ATENCAO","mensagem":"Pouca luz"}]}"""
        )!!
        assertEquals(1, a.size)
        assertEquals("LUZ_INSUFICIENTE", a[0].tipo)
    }
}

package br.ufg.naodenemagua

import br.ufg.naodenemagua.conexao.MotivoFalha
import br.ufg.naodenemagua.conexao.classificar
import br.ufg.naodenemagua.contrato.Contratos
import org.eclipse.paho.client.mqttv3.MqttException
import org.eclipse.paho.client.mqttv3.MqttSecurityException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.security.cert.CertPathValidatorException
import java.time.Instant
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/** Leitura dos contratos v1 no app e traducao das falhas de conexao. */
class ContratosTest {

    private val estadoValido = """
        {"schemaVersion":1,"eventType":"EstadoVaso","producerId":"servico-irrigacao","entityId":"vaso-01",
         "generatedAt":"2026-11-24T18:03:12.512Z","publishIntervalMs":5000,
         "solo":{"estado":"NORMAL","umidadePct":58,"idadeMs":820,"bombaLigada":false,"autorizado":false},
         "ar":{"estado":"NORMAL","umidadePct":61.3,"temperaturaC":24.5,"umidificadorLigado":false},
         "reservatorios":{"AGUA":{"estado":"OK","nivelPct":72},"ADUBO":{"estado":"DESCONHECIDO","nivelPct":null}},
         "irrigacao":{"bloqueada":false,"motivo":null},
         "adubacao":{"estado":"OCIOSO","ec25UsCm":null,"dosesNaJanela":0,"excesso":false},
         "falhaPendente":false}
    """.trimIndent()

    @Test
    fun estadoVasoValidoELido() {
        val e = Contratos.estadoVaso(estadoValido)
        assertNotNull(e)
        e!!
        assertEquals("vaso-01", e.entityId)
        assertEquals(58.0, e.soloUmidadePct!!, 0.0)
        assertEquals(72.0, e.reservatorios.getValue("AGUA").nivelPct!!, 0.0)
        assertNull(e.reservatorios.getValue("ADUBO").nivelPct)
        assertNull(e.irrigacaoMotivo)
        assertNull(e.ec25UsCm)
    }

    @Test
    fun falhasPendentesEOpcional() {
        assertTrue(Contratos.estadoVaso(estadoValido)!!.falhasPendentes.isEmpty())
        val comFalha = JSONObject(estadoValido).put("falhaPendente", true)
            .put("falhasPendentes", org.json.JSONArray(listOf("IRRIGACAO"))).toString()
        assertEquals(setOf("IRRIGACAO"), Contratos.estadoVaso(comFalha)!!.falhasPendentes)
    }

    @Test
    fun estadoVasoDeOutraVersaoOuTipoERejeitado() {
        assertNull(Contratos.estadoVaso(JSONObject(estadoValido).put("schemaVersion", 2).toString()))
        assertNull(Contratos.estadoVaso(JSONObject(estadoValido).put("eventType", "AlertaCuidado").toString()))
        assertNull(Contratos.estadoVaso(JSONObject(estadoValido).apply { remove("solo") }.toString()))
        assertNull(Contratos.estadoVaso("{nao e json"))
    }

    @Test
    fun servicoParadoDepoisDeTresPulsosSemAtualizacao() {
        val e = Contratos.estadoVaso(estadoValido)!!
        val gerado = Instant.parse("2026-11-24T18:03:12.512Z").toEpochMilli()
        assertFalse(e.servicoParado(gerado + 14_000))
        assertTrue(e.servicoParado(gerado + 16_000))
    }

    @Test
    fun alertaComSeveridadeDesconhecidaERejeitado() {
        val alerta = """{"schemaVersion":1,"eventId":"a1","eventType":"AlertaCuidado","producerId":"servico-irrigacao",
            "entityId":"vaso-01","alertType":"SOLO_SECO","severity":"ATENCAO","message":"Solo seco.",
            "correlationId":"c1","issuedAt":"2026-11-24T18:00:00.000Z","ttlMs":60000}"""
        assertNotNull(Contratos.alerta(alerta))
        assertNull(Contratos.alerta(alerta.replace("ATENCAO", "PANICO")))
        assertTrue(Contratos.alerta(alerta)!!.vencido(Instant.parse("2026-11-24T18:01:00.001Z").toEpochMilli()))
    }

    @Test
    fun heartbeatOfflineDaWillMessage() {
        val hb = """{"schemaVersion":1,"eventType":"EstadoConectividade","deviceId":"sim-vaso-01","entityId":"vaso-01",
            "bootId":"a1b2","state":"OFFLINE","reason":"lwt","sig":"${"0".repeat(64)}"}"""
        assertEquals("OFFLINE", Contratos.conectividade(hb)!!.state)
    }

    @Test
    fun solicitacaoSaiNoContrato() {
        val j = JSONObject(
            Contratos.solicitacao("req-12345678", "app-vaso-01", "vaso-01", "RECONHECER_FALHA",
                Instant.parse("2026-11-24T18:04:00Z"), 30_000)
        )
        assertEquals(1, j.getInt("schemaVersion"))
        assertEquals("SolicitacaoApp", j.getString("eventType"))
        assertEquals("app-vaso-01", j.getString("deviceId"))
        assertEquals("2026-11-24T18:04:00Z", j.getString("createdAt"))
        assertEquals(8, j.length())
    }

    @Test
    fun falhasDeConexaoViramMotivoAcionavel() {
        assertEquals(MotivoFalha.CREDENCIAIS, classificar(MqttSecurityException(MqttException.REASON_CODE_FAILED_AUTHENTICATION.toInt())))
        assertEquals(MotivoFalha.NAO_AUTORIZADO, classificar(MqttSecurityException(MqttException.REASON_CODE_NOT_AUTHORIZED.toInt())))
        assertEquals(MotivoFalha.INALCANCAVEL, classificar(MqttException(ConnectException("Connection refused"))))
        assertEquals(MotivoFalha.NOME_SERVIDOR, classificar(MqttException(SSLPeerUnverifiedException("Host: 10.0.0.5"))))
        assertEquals(MotivoFalha.CERTIFICADO,
            classificar(MqttException(SSLHandshakeException("handshake").apply { initCause(CertPathValidatorException("Trust anchor not found")) })))
        // Achado no aparelho: pelo adb reverse, servidor fora do ar = handshake encerrado, NAO certificado errado.
        assertEquals(MotivoFalha.INALCANCAVEL,
            classificar(MqttException(SSLHandshakeException("Connection closed by peer"))))
    }
}

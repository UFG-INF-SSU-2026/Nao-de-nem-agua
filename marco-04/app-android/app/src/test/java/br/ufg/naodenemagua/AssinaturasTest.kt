package br.ufg.naodenemagua

import br.ufg.naodenemagua.conexao.Assinaturas
import br.ufg.naodenemagua.conexao.Autenticidade
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

/**
 * Broker publico: o app e o servico (Node) tem de concordar byte a byte. Os
 * vetores abaixo foram gerados pelo seguranca/index.js do proprio projeto, com
 * uma chave ECDSA DESCARTAVEL criada so para este teste (nao e a do servico).
 */
class AssinaturasTest {

    private val pemTeste = """
        -----BEGIN PUBLIC KEY-----
        MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQtTRGRahABHfcneAI+e8lEaJGj1O
        8JfJcopFlWGwRIj2cNU97FxehsP/zuVBiio0vFg5bdbPN6/0WXvHQA95Kg==
        -----END PUBLIC KEY-----
    """.trimIndent()

    private val topicoResposta = "naodenemagua/v1/vaso/vaso-01/state/vaso"
    private val assinadoPeloNode = "{\"schemaVersion\":1,\"eventType\":\"RespostaApp\",\"requestId\":\"req-00000001\"," +
        "\"result\":\"EXECUTADA\",\"assinatura\":\"3045022033e777fe926975c8e88c3db8e41bc4eaa70f3b2267ec2fc52d124be93b5a2de4" +
        "022100ea082d925616dba1ada4a9809e6f1419493c85772242c395247be06cad247a3b\"}"

    @Test
    fun assinaturaDoServicoGeradaNoNodeConfereNoApp() {
        val chave = Assinaturas.chavePublicaDePem(pemTeste)
        assertEquals(Autenticidade.VALIDA, Assinaturas.verificarServico(chave, topicoResposta, assinadoPeloNode))
    }

    @Test
    fun corpoTopicoOuChaveTrocadosInvalidam() {
        val chave = Assinaturas.chavePublicaDePem(pemTeste)
        assertEquals(
            Autenticidade.INVALIDA,
            Assinaturas.verificarServico(chave, topicoResposta, assinadoPeloNode.replace("EXECUTADA", "REJEITADA"))
        )
        assertEquals(
            Autenticidade.INVALIDA,
            Assinaturas.verificarServico(chave, "naodenemagua/v1/vaso/vaso-02/state/vaso", assinadoPeloNode)
        )
        val outra = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        assertEquals(Autenticidade.INVALIDA, Assinaturas.verificarServico(outra.public, topicoResposta, assinadoPeloNode))
    }

    @Test
    fun mensagemSemAssinaturaEAusente() {
        val chave = Assinaturas.chavePublicaDePem(pemTeste)
        val semAssinatura = "{\"schemaVersion\":1,\"eventType\":\"RespostaApp\",\"result\":\"EXECUTADA\"}"
        assertEquals(Autenticidade.AUSENTE, Assinaturas.verificarServico(chave, topicoResposta, semAssinatura))
        // Uma assinatura no meio do JSON nao conta: tem de ser o ultimo campo.
        val noMeio = "{\"assinatura\":\"${"ab".repeat(70)}\",\"result\":\"EXECUTADA\"}"
        assertEquals(Autenticidade.AUSENTE, Assinaturas.verificarServico(chave, topicoResposta, noMeio))
    }

    @Test
    fun hmacDoAppIgualAoDoServico() {
        val chave = Assinaturas.desHex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
        val topico = "naodenemagua/v1/vaso/vaso-01/telemetry/light"
        val corpo = "{\"schemaVersion\":1,\"eventType\":\"LeituraLuz\",\"lux\":512.5}"
        // Mesmo texto que seguranca.assinarTexto() produz no Node.
        assertEquals(
            "{\"schemaVersion\":1,\"eventType\":\"LeituraLuz\",\"lux\":512.5," +
                "\"sig\":\"793512a11e0cd40627cfaa4cea1539c03f63043dd086b2343d8f30d561bcb924\"}",
            Assinaturas.assinarApp(chave, topico, corpo)
        )
    }

    @Test
    fun chavesDoAppLidasDoJsonGerado() {
        val json = """{"_comment":"x","apps":{"app-vaso-01":{"vasoId":"vaso-01","chave":"0a0b"}}}"""
        val apps = Assinaturas.chavesAppDeJson(json)
        assertEquals("vaso-01", apps.getValue("app-vaso-01").vasoId)
        assertTrue(apps.getValue("app-vaso-01").chave.contentEquals(byteArrayOf(0x0a, 0x0b)))
    }
}

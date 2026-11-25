package br.ufg.naodenemagua

import br.ufg.naodenemagua.contrato.RespostaApp
import br.ufg.naodenemagua.ui.PEDIDO_TTL_MS
import br.ufg.naodenemagua.ui.Pedido
import br.ufg.naodenemagua.ui.Rotulos
import br.ufg.naodenemagua.ui.reaproveitavel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Resultado da operacao mostrado ao usuario e politica do "tentar de novo". */
class PedidoTest {

    private fun resposta(result: String, detail: String = "") =
        RespostaApp("req-1", "RECONHECER_FALHA", result, detail, Instant.EPOCH)

    @Test
    fun executadaDizOQueFoiLiberado() {
        val r = Rotulos.resultado(resposta("EXECUTADA", "irrigacao liberada, adubacao liberada"))
        assertEquals(Rotulos.Tom.SUCESSO, r.tom)
        assertEquals("Irrigação e adubação automática liberada.", r.detalhe)
    }

    @Test
    fun duplicadaDeUmPedidoAtendidoESucesso() {
        // O retry de quem nao recebeu a resposta: o servico devolve o resultado original.
        val r = Rotulos.resultado(resposta("IGNORADA_DUPLICADA", "resultado original: EXECUTADA"))
        assertEquals(Rotulos.Tom.SUCESSO, r.tom)
    }

    @Test
    fun expiradaEContratoSaoErro() {
        assertEquals(Rotulos.Tom.ERRO, Rotulos.resultado(resposta("REJEITADA_EXPIRADA")).tom)
        assertEquals(Rotulos.Tom.ERRO, Rotulos.resultado(resposta("REJEITADA_CONTRATO", "x")).tom)
        assertEquals(Rotulos.Tom.INFO, Rotulos.resultado(resposta("NADA_A_RECONHECER")).tom)
    }

    @Test
    fun tentarDeNovoReaproveitaOPedidoSoDentroDoPrazo() {
        val criado = Instant.parse("2026-11-24T18:00:00Z")
        val semResposta = Pedido.SemResposta("req-1", criado)
        assertTrue(semResposta.reaproveitavel(criado.toEpochMilli() + 10_000))
        assertFalse(semResposta.reaproveitavel(criado.toEpochMilli() + PEDIDO_TTL_MS))
        // Pedido concluido nunca e reenviado: o proximo toque e um pedido novo.
        assertFalse(Pedido.Concluido("req-1", criado, resposta("EXECUTADA")).reaproveitavel(criado.toEpochMilli()))
    }

    @Test
    fun codigoDesconhecidoNaoQuebraARotulagem() {
        assertEquals("ESTADO_NOVO", Rotulos.estadoSolo("ESTADO_NOVO"))
        assertEquals("Alerta futuro", Rotulos.tipoAlerta("ALERTA_FUTURO"))
        assertEquals("reservatório de água crítico", Rotulos.motivoBloqueio("reservatorio_agua_critico"))
    }
}

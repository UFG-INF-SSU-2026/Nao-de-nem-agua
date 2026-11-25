package br.ufg.naodenemagua.ui

import br.ufg.naodenemagua.contrato.RespostaApp
import java.time.Instant

/**
 * Ciclo de vida de um pedido RECONHECER_FALHA, do botao ao resultado.
 *
 * O requestId e o createdAt nascem no primeiro toque e se mantem no "tentar de
 * novo": o servico deduplica pelo requestId (o efeito nao se repete) e o prazo
 * continua sendo o do pedido original -- depois dele, o servico responde
 * REJEITADA_EXPIRADA e o usuario faz um pedido novo.
 */
sealed interface Pedido {
    val requestId: String
    val criadoEm: Instant

    data class Enviando(override val requestId: String, override val criadoEm: Instant) : Pedido

    /** PUBACK recebido: o broker aceitou; falta o servico responder. */
    data class Aguardando(override val requestId: String, override val criadoEm: Instant) : Pedido

    /** Nao foi possivel publicar (sem conexao, broker recusou). */
    data class FalhaEnvio(override val requestId: String, override val criadoEm: Instant, val motivo: String) : Pedido

    /** Publicado, mas o servico nao respondeu no prazo. */
    data class SemResposta(override val requestId: String, override val criadoEm: Instant) : Pedido

    data class Concluido(override val requestId: String, override val criadoEm: Instant, val resposta: RespostaApp) : Pedido
}

const val PEDIDO_TTL_MS = 30_000L
const val PEDIDO_ESPERA_RESPOSTA_MS = 8_000L

/** "Tentar de novo" reaproveita o pedido enquanto ele ainda vale; depois, um pedido novo. */
fun Pedido.reaproveitavel(agoraMs: Long): Boolean =
    (this is Pedido.SemResposta || this is Pedido.FalhaEnvio) &&
        agoraMs - criadoEm.toEpochMilli() < PEDIDO_TTL_MS

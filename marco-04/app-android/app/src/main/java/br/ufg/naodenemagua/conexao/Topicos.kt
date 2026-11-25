package br.ufg.naodenemagua.conexao

/**
 * Topicos do vaso, iguais aos de contrato/index.js (topicos()). O app so pode
 * assinar e publicar o que o papel `app` permite em seguranca/acl.json.
 */
class Topicos(val vasoId: String, prefixo: String = "naodenemagua/v1") {
    val base = "$prefixo/vaso/$vasoId"

    /** EstadoVaso, RETIDO: chega assim que o app assina. */
    val estado = "$base/state/vaso"
    val alertas = "$base/alert/#"
    val resposta = "$base/app/resposta"
    val heartbeat = "$base/status/heartbeat"

    /** Os dois topicos em que o app publica: pedidos e a luz medida pelo celular. */
    val solicitacao = "$base/app/solicitacao"
    val luz = "$base/telemetry/light"

    val assinaturas: List<String> get() = listOf(estado, alertas, resposta, heartbeat)
}

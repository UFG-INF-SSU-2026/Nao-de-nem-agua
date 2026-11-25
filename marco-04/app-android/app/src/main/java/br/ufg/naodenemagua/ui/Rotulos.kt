package br.ufg.naodenemagua.ui

import br.ufg.naodenemagua.contrato.RespostaApp

/**
 * Traducao dos codigos do contrato (estados das regras do servico, tipos de
 * alerta, resultados de pedido) para o que o usuario le. Codigo desconhecido
 * aparece como veio: um estado novo do servico nao quebra o app.
 */
object Rotulos {

    fun estadoSolo(e: String): String = when (e) {
        "DESCONHECIDO" -> "Aguardando leitura"
        "NORMAL" -> "Normal"
        "AGUARDANDO" -> "Secando — confirmando leituras"
        "AUTORIZADO" -> "Seco — irrigação autorizada"
        "DADO_OBSOLETO" -> "Leitura vencida"
        "LEITURA_INVALIDA" -> "Sensor sem leitura válida"
        "DISPOSITIVO_OFFLINE" -> "Dispositivo offline"
        else -> e
    }

    fun estadoAr(e: String): String = when (e) {
        "DESCONHECIDO" -> "Aguardando leitura"
        "NORMAL" -> "Normal"
        "INVALIDO" -> "Sensor sem leitura válida"
        "OBSOLETO" -> "Leitura vencida"
        else -> e
    }

    fun estadoNivel(e: String): String = when (e) {
        "DESCONHECIDO" -> "Sem leitura"
        "OK" -> "OK"
        "BAIXO" -> "Baixo"
        "CRITICO" -> "Crítico"
        "INVALIDO" -> "Sensor sem leitura"
        else -> e
    }

    fun estadoAdubacao(e: String): String = when (e) {
        "OCIOSO" -> "Em espera"
        "AGUARDANDO_IRRIGACAO" -> "Irrigando antes de medir"
        "AGUARDANDO_ABSORCAO" -> "Aguardando absorção"
        "MEDINDO" -> "Medindo nutrientes"
        "DOSANDO" -> "Aplicando fertilizante"
        "VERIFICANDO" -> "Conferindo o efeito da dose"
        "BLOQUEADA" -> "Bloqueada por falha"
        else -> e
    }

    fun estadoLuz(e: String): String = when (e) {
        "SEM_MEDICAO" -> "Sem medição"
        "ADEQUADA" -> "Adequada"
        "POUCA_LUZ" -> "Pouca luz"
        "LUZ_EXCESSIVA" -> "Luz excessiva"
        else -> e
    }

    fun motivoBloqueio(m: String?): String = when (m) {
        null -> "—"
        "reservatorio_agua_critico" -> "reservatório de água crítico"
        "irrigacao_bloqueada_sem_efeito" -> "a última irrigação não teve efeito (bomba sem fluxo?)"
        "intertravamento_bomba_adubo" -> "bomba de fertilizante em uso"
        else -> m.replace('_', ' ')
    }

    fun tipoAlerta(t: String): String = when (t) {
        "SOLO_SECO" -> "Solo seco"
        "IRRIGACAO_EXECUTADA" -> "Irrigação feita"
        "IRRIGACAO_RECUSADA" -> "Irrigação recusada"
        "DADO_OBSOLETO" -> "Leitura vencida"
        "DISPOSITIVO_OFFLINE" -> "Dispositivo offline"
        "DISPOSITIVO_RECUPERADO" -> "Dispositivo de volta"
        "RESERVATORIO_BAIXO" -> "Reservatório baixo"
        "RESERVATORIO_CRITICO" -> "Reservatório crítico"
        "RESERVATORIO_NORMALIZADO" -> "Reservatório reabastecido"
        "SENSOR_FALHOU" -> "Sensor falhou"
        "SENSOR_RECUPERADO" -> "Sensor de volta"
        "FALHA_IRRIGACAO" -> "Falha na irrigação"
        "UMIDIFICADOR_ACIONADO" -> "Umidificador ligado"
        "ADUBACAO_EXECUTADA" -> "Adubação feita"
        "FALHA_ADUBACAO" -> "Falha na adubação"
        "EXCESSO_NUTRIENTES" -> "Excesso de nutrientes"
        "ATUACAO_RECUSADA" -> "Atuação recusada"
        "LUZ_INSUFICIENTE" -> "Pouca luz"
        "LUZ_EXCESSIVA" -> "Luz excessiva"
        "LUZ_NORMALIZADA" -> "Luz adequada"
        else -> t.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
    }

    enum class Tom { SUCESSO, INFO, ERRO }

    data class Resultado(val titulo: String, val detalhe: String, val tom: Tom)

    /**
     * O "resultado da operacao" do pedido. IGNORADA_DUPLICADA nao e erro: o
     * pedido ja tinha sido tratado (o retry de quem nao recebeu a resposta), e o
     * detail traz o resultado original.
     */
    fun resultado(r: RespostaApp): Resultado = when (r.result) {
        "EXECUTADA" -> Resultado("Falha reconhecida", liberadas(r.detail), Tom.SUCESSO)
        "NADA_A_RECONHECER" -> Resultado("Nada a reconhecer", "Não havia falha pendente.", Tom.INFO)
        "IGNORADA_DUPLICADA" ->
            if ("EXECUTADA" in r.detail) Resultado("Falha reconhecida", "O pedido já tinha sido atendido.", Tom.SUCESSO)
            else Resultado("Pedido já tratado", r.detail, Tom.INFO)
        "REJEITADA_EXPIRADA" -> Resultado("Pedido expirado", "Chegou tarde ao serviço. Tente de novo.", Tom.ERRO)
        "REJEITADA_CONTRATO" -> Resultado("Pedido recusado", r.detail, Tom.ERRO)
        else -> Resultado(r.result, r.detail, Tom.INFO)
    }

    private fun liberadas(detail: String): String {
        val partes = buildList {
            if ("irrigacao" in detail) add("irrigação")
            if ("adubacao" in detail) add("adubação")
        }
        return if (partes.isEmpty()) detail
        else partes.joinToString(" e ").replaceFirstChar { it.uppercase() } + " automática liberada."
    }
}

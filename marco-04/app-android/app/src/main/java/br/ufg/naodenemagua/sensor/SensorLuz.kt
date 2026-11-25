package br.ufg.naodenemagua.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Sensor de luz ambiente do celular (Sensor.TYPE_LIGHT, em lux).
 *
 * O sensor do Android e "on-change": so entrega evento quando a luz muda. Por
 * isso a janela de medicao (JanelaLuz) guarda a ultima leitura -- luz parada e
 * luz valida, nao ausencia de dado.
 */
class SensorLuz(contexto: Context) {
    private val gerente = contexto.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? = gerente.getDefaultSensor(Sensor.TYPE_LIGHT)

    val disponivel: Boolean get() = sensor != null
    val nome: String get() = sensor?.name ?: "sem sensor"

    /** Leituras em lux enquanto houver coletor; o registro e desfeito ao cancelar. */
    fun leituras(): Flow<Float> = callbackFlow {
        val s = sensor ?: run { close(); return@callbackFlow }
        val ouvinte = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                trySend(e.values[0])
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        // SENSOR_DELAY_NORMAL (~200 ms): bastante para luz, e economiza bateria.
        gerente.registerListener(ouvinte, s, SensorManager.SENSOR_DELAY_NORMAL)
        awaitClose { gerente.unregisterListener(ouvinte) }
    }
}

/**
 * Agrega as amostras de uma janela. Sem amostra nova na janela, repete a ultima
 * (samples = 0): o sensor nao mudou porque a luz nao mudou.
 */
class JanelaLuz {
    private var soma = 0.0
    private var n = 0
    private var ultima: Float? = null

    fun adicionar(lux: Float) {
        soma += lux
        n += 1
        ultima = lux
    }

    /** Media da janela (ou a ultima leitura) e o numero de amostras; null se nunca leu. */
    fun fechar(): Pair<Double, Int>? {
        val resultado = when {
            n > 0 -> (soma / n) to n
            ultima != null -> ultima!!.toDouble() to 0
            else -> null
        }
        soma = 0.0
        n = 0
        return resultado
    }

    val ultimaLeitura: Float? get() = ultima
}

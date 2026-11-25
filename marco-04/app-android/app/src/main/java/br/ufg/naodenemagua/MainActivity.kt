package br.ufg.naodenemagua

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.ufg.naodenemagua.ui.AberturaTela
import br.ufg.naodenemagua.ui.AcoesPainel
import br.ufg.naodenemagua.ui.AppViewModel
import br.ufg.naodenemagua.ui.BoasVindasTela
import br.ufg.naodenemagua.ui.DadosLuz
import br.ufg.naodenemagua.ui.DadosPainel
import br.ufg.naodenemagua.ui.LoginTela
import br.ufg.naodenemagua.ui.PainelTela
import br.ufg.naodenemagua.ui.Tela
import br.ufg.naodenemagua.ui.theme.NaoDeNemAguaTheme

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NaoDeNemAguaTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    App(vm)
                }
            }
        }
    }

    // O sensor de luz so mede com o app na tela: economiza bateria, e e quando
    // o celular esta de fato ao lado da planta.
    override fun onStart() {
        super.onStart()
        vm.primeiroPlano(true)
    }

    override fun onStop() {
        vm.primeiroPlano(false)
        super.onStop()
    }
}

/** Cada tela cuida das proprias margens de sistema (barra de status, navegacao, teclado). */
@Composable
private fun App(vm: AppViewModel) {
    val tela by vm.tela.collectAsStateWithLifecycle()
    AnimatedContent(
        targetState = tela,
        contentKey = { it::class },
        transitionSpec = { fadeIn(tween(350)) togetherWith fadeOut(tween(200)) },
        label = "tela"
    ) { t ->
        when (t) {
            Tela.Abrindo -> AberturaTela()
            Tela.BoasVindas -> BoasVindasTela(vm::concluirBoasVindas)
            is Tela.Login -> LoginTela(t.config, vm::entrar)
            Tela.Painel -> {
                val conexao by vm.estadoConexao.collectAsStateWithLifecycle()
                val estado by vm.estadoVaso.collectAsStateWithLifecycle()
                val dispositivo by vm.dispositivo.collectAsStateWithLifecycle()
                val negadas by vm.assinaturasNegadas.collectAsStateWithLifecycle()
                val rejeitadas by vm.rejeitadas.collectAsStateWithLifecycle()
                val alertas by vm.alertas.collectAsStateWithLifecycle()
                val pedido by vm.pedido.collectAsStateWithLifecycle()
                val medirLuz by vm.medirLuz.collectAsStateWithLifecycle()
                val luzLocal by vm.luzLocal.collectAsStateWithLifecycle()
                val historico by vm.historico.collectAsStateWithLifecycle()
                val periodo by vm.periodoHoras.collectAsStateWithLifecycle()
                val config by vm.config.collectAsStateWithLifecycle()
                PainelTela(
                    DadosPainel(
                        conexao, estado, dispositivo, alertas, pedido, negadas, rejeitadas,
                        DadosLuz(vm.sensorLuzDisponivel, vm.nomeSensorLuz, medirLuz, luzLocal),
                        historico, periodo, config
                    ),
                    AcoesPainel(vm::tentarDeNovo, vm::sair, vm::reconhecerFalha, vm::dispensarPedido, vm::alternarMedicaoLuz,
                        vm::escolherPeriodo, vm::carregarHistorico
                    )
                )
            }
        }
    }
}

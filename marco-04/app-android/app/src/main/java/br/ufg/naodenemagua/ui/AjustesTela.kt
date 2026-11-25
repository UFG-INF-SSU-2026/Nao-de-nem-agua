package br.ufg.naodenemagua.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import br.ufg.naodenemagua.conexao.EstadoConexao

/**
 * Aba "Conexao": com quem o app esta falando, como (seguranca), o sensor do
 * celular e o diagnostico que antes ficava no rodape do painel. Tambem e onde
 * se sai da conta.
 */
@Composable
fun AjustesTela(dados: DadosPainel, acoes: AcoesPainel, agora: Long, modifier: Modifier = Modifier) {
    var confirmarSaida by rememberSaveable { mutableStateOf(false) }
    val config = dados.config
    val conexao = dados.conexao

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        CartaoSecao("Broker", Icones.Wifi, acao = { PilulaConexao(conexao) }) {
            if (config != null) {
                Linha("Servidor", "${config.host}:${config.porta}", icone = Icones.Servidor)
                Linha("Usuário", config.usuario, icone = Icones.Usuario)
                Linha("Vaso", config.vasoId, icone = Icones.Vaso)
            }
            when (conexao) {
                is EstadoConexao.Conectado -> Linha("Conectado há", duracao(agora - conexao.desdeMs), icone = Icones.Relogio)
                is EstadoConexao.Reconectando -> Linha("Sem conexão há", duracao(agora - conexao.desdeMs), AMARELO, Icones.Relogio)
                is EstadoConexao.Falha -> Aviso(conexao.motivo.mensagem, Sinal.ERRO)
                else -> Unit
            }
            OutlinedButton(onClick = acoes.tentarDeNovo, modifier = Modifier.fillMaxWidth()) {
                Icon(Icones.Atualizar, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Reconectar")
            }
        }

        CartaoSecao("Segurança", Icones.Escudo, sinal = Sinal.OK) {
            ItemSeguranca(Icones.Cadeado, "MQTT sobre TLS", "Tudo o que sai e chega do celular vai cifrado.")
            ItemSeguranca(Icones.Escudo, "Só a CA do grupo", "O certificado do broker é conferido contra a CA própria do projeto, inclusive o nome do servidor.")
            ItemSeguranca(Icones.Usuario, "Identidade própria", "Usuário e senha deste app; o broker só deixa ler e publicar nos tópicos do vaso.")
        }

        CartaoSecao(
            "Sensor de luz", Icones.Celular,
            corIcone = MaterialTheme.colorScheme.tertiary, fundoIcone = MaterialTheme.colorScheme.tertiaryContainer
        ) {
            if (!dados.luz.disponivel) {
                Text("Este aparelho não tem sensor de luz.", color = CINZA, style = MaterialTheme.typography.bodyMedium)
            } else {
                Linha("Sensor", dados.luz.nomeSensor, icone = Icones.Sol)
                Linha("Medição", if (dados.luz.medir) "Ligada" else "Pausada", if (dados.luz.medir) VERDE else null, Icones.Info)
                Linha("Leituras publicadas", "${dados.luz.local.publicadas}", icone = Icones.Grafico)
            }
        }

        CartaoSecao(
            "Diagnóstico", Icones.Info,
            sinal = if (dados.assinaturasNegadas.isNotEmpty()) Sinal.ERRO else Sinal.NEUTRO
        ) {
            Linha(
                "Mensagens fora do contrato", "${dados.rejeitadas}",
                if (dados.rejeitadas > 0) AMARELO else null, Icones.Alerta
            )
            if (dados.rejeitadas > 0) {
                Text(
                    "Mensagens que não seguem o contrato são descartadas sem afetar o painel.",
                    style = MaterialTheme.typography.bodySmall, color = CINZA
                )
            }
            if (dados.assinaturasNegadas.isEmpty()) {
                Linha("Assinaturas", "todas aceitas", VERDE, Icones.Certo)
            } else {
                Aviso("Assinaturas recusadas pelo broker: ${dados.assinaturasNegadas.joinToString()}", Sinal.ERRO)
            }
        }

        Sobre()

        Button(
            onClick = { confirmarSaida = true },
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = MaterialTheme.shapes.medium,
            colors = ButtonDefaults.buttonColors(containerColor = Sinal.ERRO.fundo(), contentColor = VERMELHO)
        ) {
            Icon(Icones.Sair, null, Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text("Sair e esquecer a senha")
        }
        Spacer(Modifier.height(8.dp))
    }

    if (confirmarSaida) {
        AlertDialog(
            onDismissRequest = { confirmarSaida = false },
            icon = { Icon(Icones.Sair, null) },
            title = { Text("Sair do vaso?") },
            text = { Text("A conexão é encerrada e a senha guardada neste aparelho é apagada. Os outros dados de acesso ficam salvos.") },
            confirmButton = {
                TextButton(onClick = { confirmarSaida = false; acoes.sair() }) { Text("Sair", color = VERMELHO) }
            },
            dismissButton = { TextButton(onClick = { confirmarSaida = false }) { Text("Cancelar") } }
        )
    }
}

@Composable
private fun ItemSeguranca(icone: androidx.compose.ui.graphics.vector.ImageVector, titulo: String, texto: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icone, null, tint = VERDE, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Spacer(Modifier.width(12.dp))
        Column {
            Text(titulo, style = MaterialTheme.typography.titleSmall)
            Text(texto, style = MaterialTheme.typography.bodySmall, color = CINZA)
        }
    }
}

@Composable
private fun Sobre() {
    val contexto = LocalContext.current
    val versao = remember {
        runCatching { contexto.packageManager.getPackageInfo(contexto.packageName, 0).versionName }.getOrNull() ?: "—"
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center
    ) {
        Image(Icones.Logo, null, Modifier.size(40.dp))
        Spacer(Modifier.width(12.dp))
        Column {
            Text("Não dê nem água", style = MaterialTheme.typography.titleSmall)
            Text("versão $versao · INF/UFG", style = MaterialTheme.typography.bodySmall, color = CINZA)
        }
    }
}

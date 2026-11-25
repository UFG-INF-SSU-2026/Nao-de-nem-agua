package br.ufg.naodenemagua.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import br.ufg.naodenemagua.conexao.ConfigConexao
import br.ufg.naodenemagua.conexao.HOST_BROKER_PUBLICO
import br.ufg.naodenemagua.conexao.ModoBroker
import br.ufg.naodenemagua.ui.theme.MarcaAgua
import br.ufg.naodenemagua.ui.theme.MarcaTeal
import br.ufg.naodenemagua.ui.theme.MarcaVerde

@Composable
fun LoginTela(inicial: ConfigConexao, aoEntrar: (ConfigConexao, Boolean) -> Unit, modifier: Modifier = Modifier) {
    var host by rememberSaveable { mutableStateOf(inicial.host) }
    var porta by rememberSaveable { mutableStateOf(inicial.porta.toString()) }
    var usuario by rememberSaveable { mutableStateOf(inicial.usuario) }
    var senha by rememberSaveable { mutableStateOf(inicial.senha) }
    var vaso by rememberSaveable { mutableStateOf(inicial.vasoId) }
    var lembrar by rememberSaveable { mutableStateOf(true) }
    var mostrarSenha by rememberSaveable { mutableStateOf(false) }
    var modo by rememberSaveable { mutableStateOf(inicial.modo) }
    val publico = modo == ModoBroker.PUBLICO

    val portaValida = porta.toIntOrNull()?.let { it in 1..65535 } == true
    // No broker publico nao ha senha: a identidade vale so como deviceId, e
    // quem autentica e a assinatura das mensagens.
    val podeEntrar = host.isNotBlank() && portaValida && usuario.isNotBlank() && (publico || senha.isNotEmpty()) && vaso.isNotBlank()
    val entrar = { if (podeEntrar) aoEntrar(ConfigConexao(host, porta.toInt(), usuario, senha, vaso, modo), lembrar) }
    val trocarModo = { novo: ModoBroker ->
        if (novo != modo) {
            modo = novo
            // Sugere o servidor de cada caminho, sem apagar um endereco digitado.
            if (novo == ModoBroker.PUBLICO && (host == "localhost" || host.isBlank())) host = HOST_BROKER_PUBLICO
            if (novo == ModoBroker.GRUPO && host == HOST_BROKER_PUBLICO) host = "localhost"
            porta = "8883"
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
    ) {
        // Cabecalho com a marca
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(bottomStart = 36.dp, bottomEnd = 36.dp))
                .background(Brush.linearGradient(listOf(MarcaVerde, MarcaTeal, MarcaAgua)))
                .statusBarsPadding()
                .padding(start = 28.dp, end = 28.dp, top = 28.dp, bottom = 64.dp)
        ) {
            Column {
                Image(Icones.Logo, contentDescription = null, modifier = Modifier.size(72.dp))
                Spacer(Modifier.height(16.dp))
                Text("Olá! 🌱", style = MaterialTheme.typography.titleMedium, color = Color.White.copy(alpha = 0.9f))
                Text("Vamos ver como está\nsua planta", style = MaterialTheme.typography.headlineMedium, color = Color.White)
            }
        }

        // Formulario, sobreposto ao cabecalho
        Card(
            Modifier.padding(horizontal = 16.dp).offset(y = (-40).dp).fillMaxWidth(),
            shape = MaterialTheme.shapes.extraLarge,
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest),
            elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Rotulo("Qual broker")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    listOf(ModoBroker.GRUPO to "Do grupo", ModoBroker.PUBLICO to "Público (Wokwi)").forEachIndexed { i, (m, rotulo) ->
                        SegmentedButton(
                            selected = modo == m,
                            onClick = { trocarModo(m) },
                            shape = SegmentedButtonDefaults.itemShape(i, 2),
                            icon = {
                                SegmentedButtonDefaults.Icon(modo == m) {
                                    Icon(if (m == ModoBroker.GRUPO) Icones.Escudo else Icones.Wifi, null, Modifier.size(18.dp))
                                }
                            }
                        ) { Text(rotulo) }
                    }
                }
                if (publico) {
                    Aviso(
                        "O mesmo broker do ESP32 no Wokwi. Nenhuma senha é enviada a ele: o app só aceita mensagens " +
                            "assinadas pelo serviço e assina tudo o que publica. Rode o serviço com MQTT_URL apontando para ele.",
                        Sinal.INFO
                    )
                }

                Spacer(Modifier.height(4.dp))
                Rotulo("Onde está o broker")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Campo(
                        host, { host = it.trim() }, "Servidor", Icones.Servidor, Modifier.weight(1f),
                        teclado = KeyboardType.Uri
                    )
                    Campo(
                        porta, { porta = it.filter(Char::isDigit).take(5) }, "Porta", null, Modifier.width(100.dp),
                        teclado = KeyboardType.Number, erro = !portaValida
                    )
                }
                Text(
                    if (publico) "Precisa de internet no celular. O histórico fica só no broker do grupo."
                    else "Pelo cabo USB use localhost (com adb reverse).",
                    style = MaterialTheme.typography.bodySmall, color = CINZA
                )

                Spacer(Modifier.height(4.dp))
                Rotulo("Sua identidade")
                Campo(usuario, { usuario = it.trim() }, "Usuário", Icones.Usuario)
                if (!publico) {
                    Campo(
                        senha, { senha = it.trim() }, "Senha", Icones.Cadeado,
                        teclado = KeyboardType.Password,
                        visual = if (mostrarSenha) VisualTransformation.None else PasswordVisualTransformation(),
                        final = {
                            IconButton(onClick = { mostrarSenha = !mostrarSenha }) {
                                Icon(
                                    if (mostrarSenha) Icones.OlhoFechado else Icones.Olho,
                                    contentDescription = if (mostrarSenha) "Ocultar senha" else "Mostrar senha"
                                )
                            }
                        }
                    )
                }
                Campo(vaso, { vaso = it.trim() }, "Vaso", Icones.Vaso, ultimo = true, aoConcluir = entrar)

                Row(
                    Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable { lembrar = !lembrar },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(checked = lembrar, onCheckedChange = { lembrar = it })
                    Text(
                        if (publico) "Entrar direto ao abrir o app" else "Lembrar a senha neste aparelho",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }

                Button(
                    onClick = entrar,
                    enabled = podeEntrar,
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                    shape = MaterialTheme.shapes.medium,
                    contentPadding = PaddingValues(horizontal = 16.dp)
                ) {
                    Icon(Icones.Cadeado, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(10.dp))
                    Text("Conectar com segurança", style = MaterialTheme.typography.titleSmall)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().offset(y = (-24).dp).navigationBarsPadding().padding(horizontal = 24.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icones.Escudo, null, tint = VERDE, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                if (publico) "MQTT sobre TLS · mensagens assinadas (ECDSA e HMAC)"
                else "MQTT sobre TLS · só confia na CA do grupo",
                style = MaterialTheme.typography.labelMedium, color = CINZA
            )
        }
    }
}

@Composable
private fun Campo(
    valor: String,
    aoMudar: (String) -> Unit,
    rotulo: String,
    icone: ImageVector?,
    modifier: Modifier = Modifier.fillMaxWidth(),
    teclado: KeyboardType = KeyboardType.Text,
    erro: Boolean = false,
    visual: VisualTransformation = VisualTransformation.None,
    final: (@Composable () -> Unit)? = null,
    ultimo: Boolean = false,
    aoConcluir: () -> Unit = {}
) {
    OutlinedTextField(
        value = valor,
        onValueChange = aoMudar,
        label = { Text(rotulo) },
        leadingIcon = icone?.let { { Icon(it, null, Modifier.size(20.dp)) } },
        trailingIcon = final,
        isError = erro,
        singleLine = true,
        shape = MaterialTheme.shapes.medium,
        visualTransformation = visual,
        keyboardOptions = KeyboardOptions(
            keyboardType = teclado,
            imeAction = if (ultimo) ImeAction.Go else ImeAction.Next
        ),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { aoConcluir() }),
        modifier = modifier
    )
}

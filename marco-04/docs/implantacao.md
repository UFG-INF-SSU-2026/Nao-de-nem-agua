# Implantação — do zero ao sistema funcionando

Instruções reproduzíveis para instalar, configurar e executar **todos os
componentes** do Marco 4: broker, serviço, banco, simulador, notificador, API de
histórico e aplicativo Android. Testado em Windows 11 com PowerShell; os
comandos `npm` valem igual em Linux/macOS.

## 1. Componentes e ordem de execução

| # | Componente | Comando (pasta `marco-04`) | Porta | Depende de |
|---|---|---|---|---|
| 1 | Banco TimescaleDB (Docker) | `npm run banco` | 5432 (só 127.0.0.1) | Docker |
| 2 | Broker MQTT (Aedes) | `npm run broker` | 8883 (TLS) | `npm run seguranca` |
| 3 | Serviço de irrigação | `npm run servico` | — | broker; banco (opcional: sem ele roda em memória) |
| 4 | Dispositivo: simulador **ou** ESP32 no Wokwi | `npm run simulador` | — | broker |
| 5 | Notificador (opcional) | `npm run notificador` | — | broker |
| 6 | API de histórico | `npm run api` | 8443 (HTTPS) | banco |
| 7 | App Android | APK em [`entrega/`](../entrega) | — | broker (8883) e API (8443) |

Cada processo Node fica num terminal próprio (ou em segundo plano). A ordem acima
é a recomendada; o serviço, o simulador e o app **reconectam sozinhos** se o
broker subir depois.

## 2. Pré-requisitos (versões usadas)

| Ferramenta | Versão testada | Para quê |
|---|---|---|
| Node.js | 22.23.2 (mínimo 22) e npm 10.9.8 | broker, serviço, simulador, notificador, API e testes |
| Docker Desktop | 29.8.2 | TimescaleDB `timescale/timescaledb:2.17.2-pg16` |
| Android Studio | 2026.2.2 (traz o JDK e o SDK) | só para **compilar** o app; para instalar o APK basta o `adb` |
| Android SDK | plataforma 37, build-tools 36.0.0, platform-tools 37 | `adb` e compilação |
| Celular Android | 8.0 ou superior (API 26+); testado num Galaxy A16, Android 16 | com **Depuração USB** ligada |

Dependências Node (fixadas em `package-lock.json`): `aedes` 0.51.3, `mqtt`
5.16.0, `ajv` 8.20.0, `pg` 8.23.1, `node-forge` 1.3.1.

App: Kotlin 2.2.10, Android Gradle Plugin 9.5.2, Gradle 9.6.0 (wrapper),
Compose BOM 2026.02.01, Eclipse Paho MQTT 1.2.5, DataStore 1.1.1;
`compileSdk`/`targetSdk` 37, `minSdk` 26.

## 3. Instalação e configuração

```powershell
cd marco-04
```

```powershell
npm install
```

**Segredos da máquina** (CA própria, certificados do broker e da API, senhas de
cada identidade, senhas do banco no `.env`). Nada disso vai para o Git
(`.gitignore`): cada máquina gera o seu.

```powershell
npm run seguranca
```

Rodar de novo é seguro: só cria o que falta (identidade nova na ACL, certificado
da API) e **não** troca a CA nem as senhas existentes. `-- --forcar` regenera
tudo — e aí o app precisa ser recompilado (a CA muda).

**Banco** (primeira vez: cria o volume, os papéis `servico_irrigacao` e
`leitor_app` e os bancos `naodenemagua` e `naodenemagua_teste`):

```powershell
npm run banco
```

```powershell
npm run banco:seed
```

O `seed` cadastra o `vaso-01` como jiboia na sala (perfil de cuidado). O
contêiner reinicia sozinho com o Docker (`restart: unless-stopped`); os dados
ficam no volume `naodenemagua-dados`. O esquema (hypertables, agregados
contínuos, retenção) é migrado pelo próprio serviço na partida.

| Configuração | Onde | Observação |
|---|---|---|
| Limiares, tempos, portas | [`config.json`](../config.json) | toda chave pode ser sobrescrita por variável de ambiente (`SECAO_CHAVE`, ex. `LUZ_LUX_MIN=500`) |
| Senhas do banco | `.env` (gerado; modelo em [`.env.exemplo`](../.env.exemplo)) | lidas pelo Docker, pelo serviço e pela API |
| Identidades e permissões | [`seguranca/acl.json`](../seguranca/acl.json) | papéis `gateway`, `servico`, `notificador`, `observador`, `app` |
| Banco sem Docker | `PERSISTENCIA_HABILITADA=0` | serviço em memória (como no Marco 3); a API de histórico não funciona |

## 4. Execução

Um terminal para cada:

```powershell
npm run broker
```

```powershell
npm run servico
```

```powershell
npm run simulador
```

```powershell
npm run api
```

```powershell
npm run notificador
```

Para usar o ESP32 no Wokwi em vez do simulador, ver o “Caminho B” no
[`README`](../README.md#caminho-b--dispositivo-real-no-wokwi).

## 5. Aplicativo

### 5.1 Instalar

**Opção A — APK pronto** ([`entrega/naodenemagua-1.0-marco4.apk`](../entrega)).
Ele embute a **CA da máquina em que foi compilado** e por isso só conversa com o
broker e a API **dessa** máquina. Para usar o APK pronto em outra máquina, copie
para ela a pasta `seguranca/certs` da máquina original (CA + certificados), ou
use a opção B.

**Opção B — compilar nesta máquina** (o build copia `seguranca/certs/ca.crt`
para dentro do app):

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"; cd app-android; .\gradlew.bat assembleRelease
```

O APK sai em `app-android/app/build/outputs/apk/release/app-release.apk`. Pelo
Android Studio: abrir `app-android/`, esperar o *Gradle sync* e **Run**.

**Instalar pelo cabo** (celular com Depuração USB; aceitar o aviso no celular):

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r entrega\naodenemagua-1.0-marco4.apk
```

### 5.2 Conectar

Pelo cabo USB (recomendado), o celular enxerga o PC como `localhost` — e os
certificados já valem para `localhost`:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:8883 tcp:8883; & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:8443 tcp:8443
```

O redirecionamento some ao desconectar o cabo: rode de novo depois.

Pelo Wi-Fi: reemita os certificados para o IP desta máquina (mesma CA; o app
não precisa ser reinstalado), reinicie broker e API, libere as portas 8883 e
8443 no Firewall do Windows e use o IP no campo **Servidor** do app:

```powershell
npm run seguranca -- --broker-host 192.168.0.10
```

### 5.3 Credencial de teste

O app entra com a identidade **`app-vaso-01`** (papel `app`: lê só o próprio
vaso; publica só pedidos e a luz; nunca comanda atuador). A senha é gerada por
máquina e fica fora do Git. Para vê-la:

```powershell
npm run app:credencial
```

Na tela de login: Servidor `localhost`, Porta `8883`, Usuário `app-vaso-01`,
a senha mostrada, Vaso `vaso-01`. Credenciais administrativas (senha do
`servico-irrigacao`, chave da CA, chaves HMAC, senhas do banco) **nunca** vão
para o app.

## 6. Verificação

| Comando | O que verifica | Requer | Resultado de referência |
|---|---|---|---|
| `npm run teste` | fronteira, contrato, alertas, segurança (TLS, senha, ACL, HMAC), regras R1–R5, app (estado, pedido, ACL) e luz | nada (sobe tudo em portas livres, em memória) | 126/126, ~4 min |
| `npm run teste:unidade` | fila de gravação, perfil, restauração, R5, API (sem rede nem banco) | nada | 40/40 |
| `npm run teste:persistencia` | gravação, SIGKILL e restauração, queda do banco, perfil, menor privilégio | banco | 37/37, ~1 min (para e religa o contêiner) |
| `npm run teste:api` | TLS, identidade, autorização, entrada, dados e força bruta da API | banco | 25/25 |
| `gradlew testDebugUnitTest` (em `app-android`) | contratos, falhas de rede, pedido, luz e histórico no app | JDK do Android Studio | 23/23 |

Detalhes e relação com os requisitos em [`testes.md`](testes.md); saídas em
[`evidencias/`](evidencias/).

## 7. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `npm run banco` falha com “rode npm run seguranca” | falta o `.env` | `npm run seguranca` |
| `npm run banco` não conecta ao Docker | Docker Desktop parado | abrir o Docker Desktop e esperar ficar pronto |
| Serviço: “banco indisponível… seguindo em memória” | contêiner parado | `npm run banco`; o serviço mescla o estado quando o banco volta |
| App: “Broker inalcançável” | broker parado ou sem `adb reverse` | `npm run broker`; refazer o `adb reverse` |
| App: “O certificado do broker não é da CA do grupo” | APK compilado em outra máquina (ou depois de `--forcar`) | recompilar o app nesta máquina (§5.1, opção B) |
| App: “O certificado … não vale para este endereço” | Wi-Fi com certificado só para `localhost` | `npm run seguranca -- --broker-host <IP>` |
| App: “Usuário ou senha inválidos” | senha digitada errada ou de outra máquina | `npm run app:credencial` |
| Aba Histórico: “API de histórico inalcançável” | API parada ou sem `adb reverse tcp:8443` | `npm run api`; refazer o `adb reverse` |
| Aba Histórico: “banco não respondeu” | contêiner parado | `npm run banco` |
| `gradlew` não encontra Java | `JAVA_HOME` não aponta para o JDK do Android Studio | `$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"` |

## 8. Limitações da implantação

- O APK de entrega é assinado com a **chave de depuração** do Android Studio
  (publicação em loja dispensada pelo PDF): instala em qualquer celular com
  “fontes desconhecidas”, mas não serve para loja e não prova autoria.
- Cada máquina tem sua CA: o APK pronto só fala com a máquina em que foi
  compilado (§5.1).
- Tudo roda numa máquina só (broker, serviço, banco, API); o caminho B (Wokwi)
  usa um broker público e não tem ACL nem a API de histórico.

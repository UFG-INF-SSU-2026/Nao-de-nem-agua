# Marco 4 — mais sensores, mais atuadores, mesma fronteira

Evolução do Marco 3, em resposta ao feedback de "usar mais sensores e deixar a
solução mais complexa". A arquitetura **não mudou**: o dispositivo mede, valida
e atua; o `servico-irrigacao` guarda o estado e decide; tudo atravessa o broker
por **MQTT/TLS**, com **contrato versionado**, **comandos idempotentes** e
**HMAC**. O que cresceu foi o que passa por ela:

| | Marco 3 | Marco 4 |
|---|---|---|
| Sensores | umidade do solo (potenciômetro) | **sonda de solo 3-em-1** (custom chip: umidade, temperatura e **EC = nutrientes**), **DHT22** (ar), **2× HC-SR04** (reservatórios de água e de adubo) |
| Atuadores | bomba (LED) | **bomba de água**, **bomba de fertilizante** e **umidificador** (relés) |
| Regras no serviço | histerese + debounce + cooldown | **R1** umidificador por concessão · **R2** irrigação com bloqueio por reservatório e **verificação cruzada do efeito** · **R3** adubação por máquina de estados (irrigar antes, medir de novo, limite de doses) · **R4** estados dos reservatórios |
| Proteções no dispositivo | idempotência e prazo | + **`REJEITADO_SEGURANCA`**: reservatório crítico, intertravamento das bombas, adubo em solo seco, umidificador sem sensor |
| Verificações automáticas | 62 | **95** |

- Marco 4: sensores, regras, contrato novo e limitações → [`docs/marco-04.md`](docs/marco-04.md)

O Marco 3 já tinha, e continua valendo:

- **Novo ciclo produtor-consumidor:** o `servico-irrigacao`, que era só
  consumidor, passa a **produzir alertas de cuidado** (`AlertaCuidado`). Eles
  são consumidos pelo **notificador**, um processo independente que representa
  o aplicativo ou a Alexa no terminal, com validação, deduplicação e expiração.
- **Segurança:** **canal TLS**, **autenticação por usuário/senha**, **ACL no
  broker** e **assinatura HMAC** de cada mensagem do dispositivo.

- Segurança (canal, identidade, autorização, HMAC) → [`docs/seguranca.md`](docs/seguranca.md)
- Decisões arquiteturais → [`docs/arquitetura.md`](docs/arquitetura.md)
- Contrato e payloads → [`docs/contrato.md`](docs/contrato.md)
- Alertas, correlação, TTL e ACL futura → [`docs/alertas.md`](docs/alertas.md)
- Diagramas → [`docs/diagramas/`](docs/diagramas/) (fluxo do Marco 3; os ramos novos estão em `docs/marco-04.md`)

---

## Executar

Requer **Node.js 20+**. Não requer Docker.

```bash
cd marco-04 && npm install
```

Na primeira vez, gere a CA, o certificado do broker e as senhas de cada
identidade (esses arquivos **não** vão para o git):

```bash
npm run seguranca
```

Depois, **quatro terminais PowerShell**, todos na pasta `marco-04`:

```bash
npm run broker
```

```bash
npm run servico
```

```bash
npm run simulador
```

```powershell
npm run notificador
```

Pronto — a telemetria já está atravessando a fronteira. No terminal do
simulador, pressione `s` para secar o solo e observe a decisão acontecer. Para
os sensores novos: `h` (ar seco → umidificador), `n` (faltam nutrientes →
adubação), `r` (reservatório de água crítico → bomba bloqueada), `f` (bomba sem
fluxo → falha detectada pela verificação cruzada).

### Verificação automática

```bash
npm run teste
```

Sobe broker local (TLS) em porta livre, serviço, notificador e simulador como
subprocessos e assume o papel do dispositivo. São 95 verificações:

- **seções 1 a 7 (Marco 2):** decisão, deduplicação, contrato, expiração, retry,
  comando expirado, evento histórico e *will message*;
- **seção 8 (alertas):** acks fora de ordem, duplicatas, expiração, LWT,
  recuperação, rejeições e mensagens inválidas no notificador;
- **seções 9 a 13 (segurança):** TLS, usuário/senha, ACL e HMAC no serviço e no
  dispositivo;
- **seções 14 a 18 (Marco 4):** telemetria nova no contrato, umidificador por
  concessão, reservatório crítico bloqueando no serviço **e** no dispositivo,
  verificação cruzada do efeito da irrigação, adubação (falso positivo evitado,
  dose confirmada, limite de doses, excesso), intertravamento e bomba sem fluxo.
  Usam o **simulador real**, com as teclas enviadas por pipe.

Não depende de internet. Leva cerca de 3 minutos.

Use depois de qualquer alteração, inclusive depois da alteração feita ao vivo
durante a verificação.

---

## Teclas do simulador

| Tecla | Efeito |
|:---:|---|
| `-` `+` | desce / sobe a umidade em 5 pontos |
| `s` | solo seco (20%) — provoca a decisão |
| `m` | solo molhado (60%) — sai da histerese |
| `d` | republica o último evento com o **mesmo** `eventId` → deduplicação |
| `x` | payload fora de contrato (150%) → rejeição |
| `v` | `schemaVersion: 2` desconhecida → rejeição |
| `i` | leitura com `valid: false` |
| `p` | pausa a telemetria (silêncio) → expiração da validade |
| `k` | **mata a conexão sem DISCONNECT** → dispara o LWT |
| `q` | encerra limpo (sem LWT) |
| `a` | **ataque:** leitura seca **sem assinatura** → `ASSINATURA_AUSENTE` no serviço |
| `g` | **ataque:** assina 60% e troca para 20% → `ASSINATURA_INVALIDA` |
| `o` | **ataque:** publica com `deviceId` de outro dispositivo → broker nega e derruba (reconecta sozinho) |
| `c` | **ataque:** publica no tópico do vaso-02 → broker nega pela ACL |
| `h` / `j` | **Marco 4:** ar seco (35%) / úmido (65%) → R1 liga / desliga o umidificador |
| `n` / `b` / `l` | **Marco 4:** EC baixa (500) / alta (2500) / normal (1200) µS/cm → adubação / `EXCESSO_NUTRIENTES` |
| `r` / `t` | **Marco 4:** reservatório de água / de adubo a 5% → `RESERVATORIO_CRITICO` e bomba bloqueada |
| `w` | **Marco 4:** reabastece os dois reservatórios |
| `f` | **Marco 4:** bombas "sem fluxo" (ligam, não movem nada) → `FALHA_IRRIGACAO` / `FALHA_ADUBACAO` |
| `z` | **Marco 4:** falha do DHT22 → `SENSOR_FALHOU` e umidificador desligado |

No terminal do serviço, `e` imprime o estado corrente (solo, ar, reservatórios, verificação e adubação) e `r` reconhece uma falha de irrigação/adubação, liberando a regra bloqueada — é o lugar do botão do aplicativo.

## Ataques de demonstração

Com broker, serviço e simulador ligados, cada comando faz uma tentativa real e
mostra a recusa. A recusa aparece também no terminal de quem defende.

| Comando | Ataque | Quem barra |
|---|---|---|
| `npm run ataque -- texto-puro` | MQTT sem TLS | broker (`TLS_RECUSADO`) |
| `npm run ataque -- sem-ca` | cliente que não confia na nossa CA | o próprio cliente |
| `npm run ataque -- sem-senha` | conexão anônima | broker (`AUTH_RECUSADA`, CONNACK 5) |
| `npm run ataque -- senha-errada` | senha errada | broker (`AUTH_RECUSADA`, CONNACK 4) |
| `npm run ataque -- notificador-comanda` | notificador tenta ligar a bomba | broker (`PUBLISH_NEGADO` + desconexão) |
| `npm run ataque -- vaso-alheio` | gateway assina comandos do vaso-02 | broker (`SUBSCRIBE_NEGADO`) |
| `npm run ataque -- comando-forjado` | comando assinado sem a chave do serviço | **dispositivo** (`REJEITADO_ASSINATURA`) |

O `comando-forjado` funciona nos dois caminhos. No local, o atacante tem a
**senha do serviço** (simula vazamento), mas não a chave HMAC. No público, não
precisa de senha nenhuma. Nos dois casos, a bomba não liga.

---

## Os dois caminhos

### Caminho A — local, offline (padrão)

Broker Aedes em `mqtts://localhost:8883` (só TLS), produtor simulado.
Determinístico e sem internet. Tem **todas** as camadas: TLS com CA própria,
usuário/senha, ACL e HMAC. **É o caminho recomendado para a demonstração.**

### Caminho B — dispositivo real no Wokwi

O ESP32 simulado no Wokwi não alcança o `localhost` desta máquina, então este
caminho passa por um broker público e depende de internet.

1. Abra o Wokwi com `produtor-esp32/sketch.ino` e `produtor-esp32/diagram.json`.
2. Instale a biblioteca **PubSubClient** pela aba *Library Manager*
   (ver `produtor-esp32/libraries.txt`). Sem ela a compilação falha com
   `fatal error: PubSubClient.h: No such file or directory`.
3. Aponte o serviço para o mesmo broker:

```bash
MQTT_URL=mqtts://broker.hivemq.com:8883 npm run servico
```

No PowerShell:

```powershell
$env:MQTT_URL="mqtts://broker.hivemq.com:8883"; npm run servico
```

> O ESP32 conecta por **TLS na porta 8883** e confere o certificado do broker
> contra a Amazon Root CA 1, fixada no sketch. O broker público não tem senha
> nem ACL, e qualquer um pode publicar nos nossos tópicos. Por isso, neste
> caminho, a proteção é o **HMAC**: o serviço só aceita telemetria assinada pelo
> ESP32, e o ESP32 só executa comando assinado pelo serviço. Para ver na
> prática, rode `MQTT_URL=mqtts://broker.hivemq.com:8883 npm run ataque -- comando-forjado`
> com o ESP32 ligado: o LED da bomba não acende e o Serial mostra
> `REJEITADO_ASSINATURA`. Ver `docs/seguranca.md`.

Em outro PowerShell, configure o mesmo broker para o notificador:

```powershell
$env:MQTT_URL="mqtts://broker.hivemq.com:8883"
npm run notificador
```

O host, prefixo e vaso precisam coincidir com os valores do firmware Wokwi.
Para voltar ao broker local, use `Remove-Item Env:MQTT_URL` em cada terminal.

---

## Segundo consumidor

```bash
npm run observador
```

Assina os quatro tópicos anteriores e `alert/#` e apenas imprime. Pode ser ligado e desligado a
qualquer momento **sem que produtor ou serviço saibam que ele existe** — é a
demonstração prática do desacoplamento, e o lugar que o app Android ocupará na
evolução prevista.

---

## Condições de falha

| | Falha | Como provocar | O que observar |
|---|---|---|---|
| **F1** | queda do dispositivo | `k` no simulador | LWT publicado pelo broker → `DISPOSITIVO_OFFLINE` → autorização revogada |
| **F1b** | queda do broker | `Ctrl+C` no broker | serviço reconecta; dispositivo enfileira e reenvia como `replayed` |
| **F2** | retry de comando | `npm run teste` (seção 5b) | `IGNORADO_DUPLICADO` — o efeito **não** se repete |
| **F3** | comando expirado | `COMANDO_TTL_MS=1 npm run servico` | `REJEITADO_EXPIRADO` — não atua tarde |
| **F4** | payload inválido | `x`, `v` ou `i` no simulador | rejeição logada; o serviço **continua vivo** |

---

## Alteração ao vivo

Nenhuma alteração de comportamento exige editar código. Tudo está em
[`config.json`](config.json) e pode ser sobrescrito por variável de ambiente:

```bash
LIMIAR_LIGA=45 npm run servico      # bomba liga com solo mais úmido
VALIDADE_MS=3000 npm run servico    # dado expira mais cedo
COOLDOWN_MS=2000 npm run servico    # pulsos mais frequentes
MQTT_URL=mqtts://broker.hivemq.com:8883 npm run servico
EXIGIR_ASSINATURA=0 npm run servico # desliga o HMAC: mostra o ataque 'a' passando
```

Marco 4: as seções `ambiente`, `reservatorios`, `verificacao` e `adubacao` do
`config.json` seguem a mesma regra, com o nome `SECAO_CHAVE` em maiúsculas:

```bash
AMBIENTE_UMIDADE_AR_MIN=60 npm run servico     # umidificador liga mais cedo
ADUBACAO_EC25_MIN_US_CM=1000 npm run servico   # planta "mais exigente" em nutrientes
RESERVATORIOS_NIVEL_CRITICO_PCT=30 npm run servico
```

---

## Estrutura

```
marco-04/
├── config.json                 configuração única dos três componentes
├── seguranca/
│   ├── index.js                TLS, senha (scrypt), ACL e HMAC
│   ├── gerar.js                `npm run seguranca`: CA, certificado, senhas
│   ├── acl.json                identidades e papéis (o que cada um publica/assina)
│   └── chaves-hmac.json        chaves de demonstração por dispositivo
├── contrato/
│   ├── index.js                carregamento, validação (ajv), tópicos e conexão segura
│   └── v1/*.schema.json        oito schemas: + LeituraAmbiente, NivelReservatorio, ComandoAtuador (Marco 4)
├── produtor-esp32/             PRODUTOR — firmware Wokwi (caminho B) + custom chip sonda-solo
├── simulador-produtor/         PRODUTOR — substituto declarado (caminho A)
├── broker-local/               MIDDLEWARE — broker Aedes
├── consumidor-servico/
│   ├── src/main.js             CONSUMIDOR — pipeline e MQTT
│   ├── src/estado.js           estado temporal e expiração
│   ├── src/decisao.js          histerese, debounce, cooldown, comando
│   ├── src/alertas.js          emissão e correlação de alertas
│   ├── src/ambiente.js         R1: ar, média, validade, umidificador por concessão (Marco 4)
│   ├── src/reservatorios.js    R4: estados OK/BAIXO/CRITICO com histerese (Marco 4)
│   ├── src/verificacao.js      R2: verificação cruzada do efeito da irrigação (Marco 4)
│   ├── src/adubacao.js         R3: máquina de estados da adubação (Marco 4)
│   ├── src/atuadores.js        emissão e confirmação de ComandoAtuador (Marco 4)
│   └── src/log.js              log legível + eventos.jsonl
├── notificador/src/main.js     consumidor independente de alert/#
├── scripts/
│   ├── teste-integracao.js     verificação automática: fronteira, alertas, segurança e Marco 4 (95)
│   ├── ataques.js              `npm run ataque -- <nome>`: ataques de demonstração
│   └── observador.js           segundo consumidor
└── docs/                       arquitetura, contrato, segurança, diagramas e marco-04.md
```

---

## Roteiro da apresentação (10 min)

| Tempo | O quê |
|---|---|
| 0:00–1:30 | contexto: produtor, comunicação, consumidor — mostrar `docs/diagramas/componentes.md` |
| 1:30–4:30 | `npm run broker`, `npm run servico`, `npm run simulador`; `s` para secar; mostrar `eventId` único, a decisão no log, o comando e o ack |
| 4:30–6:00 | falhas: `k` (LWT + revogação) e o retry duplicado |
| 6:00–7:00 | decisões: por que MQTT, os dois níveis de versão, onde vive o estado, Android como segundo assinante (ligar o `observador`) |
| 7:00–9:30 | alteração ao vivo + `npm run teste` para confirmar |
| 9:30–10:00 | limitações declaradas |

**Antes de sair:** rodar `npm install` e `npm run teste` com internet, e testar o
caminho B pelo menos uma vez.

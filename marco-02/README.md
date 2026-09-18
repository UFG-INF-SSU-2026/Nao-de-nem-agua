# Marco 2 — fronteira de comunicação

Integração entre **`gateway-vaso`** (produtor) e **`servico-irrigacao`**
(consumidor), por **MQTT**, com contrato versionado, comando idempotente e
quatro condições de falha exercitáveis.

- Decisões arquiteturais → [`docs/arquitetura.md`](docs/arquitetura.md)
- Contrato e payloads → [`docs/contrato.md`](docs/contrato.md)
- Diagramas → [`docs/diagramas/`](docs/diagramas/)

---

## Executar

Requer **Node.js 20+**. Não requer Docker.

```bash
cd marco-02 && npm install
```

Depois, **três terminais**:

```bash
npm run broker
```

```bash
npm run servico
```

```bash
npm run simulador
```

Pronto — a telemetria já está atravessando a fronteira. No terminal do
simulador, pressione `s` para secar o solo e observe a decisão acontecer.

### Verificação automática

```bash
npm run teste
```

Sobe broker e serviço, assume o papel do dispositivo e verifica os 20 caminhos
da fronteira — decisão, deduplicação, contrato, expiração, retry, comando
expirado, evento histórico e *will message*. Leva cerca de 15 segundos.

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

No terminal do serviço, `e` imprime o estado corrente.

---

## Os dois caminhos

### Caminho A — local, offline (padrão)

Broker Aedes em `localhost:1883`, produtor simulado. Determinístico e sem
internet. **É o caminho recomendado para a demonstração.**

### Caminho B — dispositivo real no Wokwi

O ESP32 simulado no Wokwi não alcança o `localhost` desta máquina, então este
caminho passa por um broker público e depende de internet.

1. Abra o Wokwi com `produtor-esp32/sketch.ino` e `produtor-esp32/diagram.json`.
2. Instale a biblioteca **PubSubClient** pela aba *Library Manager*
   (ver `produtor-esp32/libraries.txt`). Sem ela a compilação falha com
   `fatal error: PubSubClient.h: No such file or directory`.
3. Aponte o serviço para o mesmo broker:

```bash
MQTT_URL=mqtt://broker.hivemq.com:1883 npm run servico
```

No PowerShell:

```powershell
$env:MQTT_URL="mqtt://broker.hivemq.com:1883"; npm run servico
```

> O broker público é **aberto, sem TLS e sem autenticação**. Qualquer um pode
> assinar e publicar nesses tópicos. É uma limitação declarada deste marco, não
> uma decisão de arquitetura — ver `docs/arquitetura.md`, seção 11.

---

## Segundo consumidor

```bash
npm run observador
```

Assina os mesmos tópicos e apenas imprime. Pode ser ligado e desligado a
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
MQTT_URL=mqtt://broker.hivemq.com:1883 npm run servico
```

---

## Estrutura

```
marco-02/
├── config.json                 configuração única dos três componentes
├── contrato/
│   ├── index.js                carregamento, validação (ajv) e tópicos
│   └── v1/*.schema.json        os quatro schemas do contrato
├── produtor-esp32/             PRODUTOR — firmware Wokwi (caminho B)
├── simulador-produtor/         PRODUTOR — substituto declarado (caminho A)
├── broker-local/               MIDDLEWARE — broker Aedes
├── consumidor-servico/
│   ├── src/main.js             CONSUMIDOR — pipeline e MQTT
│   ├── src/estado.js           estado temporal e expiração
│   ├── src/decisao.js          histerese, debounce, cooldown, comando
│   └── src/log.js              log legível + eventos.jsonl
├── scripts/
│   ├── teste-integracao.js     verificação automática dos 20 caminhos
│   └── observador.js           segundo consumidor
└── docs/                       arquitetura, contrato e diagramas
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

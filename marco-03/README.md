# Marco 3 — evolução da fronteira produtor-consumidor

Evolução do Marco 2 (**`gateway-vaso`** → **`servico-irrigacao`**, por **MQTT**,
com contrato versionado e comando idempotente), agora com **canal TLS**,
**autenticação por usuário/senha**, **ACL no broker** e **assinatura HMAC** de
cada mensagem.

- Segurança (canal, identidade, autorização, HMAC) → [`docs/seguranca.md`](docs/seguranca.md)
- Decisões arquiteturais → [`docs/arquitetura.md`](docs/arquitetura.md)
- Contrato e payloads → [`docs/contrato.md`](docs/contrato.md)
- Diagramas → [`docs/diagramas/`](docs/diagramas/)

---

## Executar

Requer **Node.js 20+**. Não requer Docker.

```bash
cd marco-03 && npm install
```

Na primeira vez, gere a CA, o certificado do broker e as senhas de cada
identidade (esses arquivos **não** vão para o git):

```bash
npm run seguranca
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

Sobe broker e serviço, assume o papel do dispositivo e verifica 41 caminhos.
Os do Marco 2 cobrem decisão, deduplicação, contrato, expiração, retry, comando
expirado, evento histórico e *will message*. Os do Marco 3, nas seções 8 a 12,
cobrem TLS, usuário/senha, ACL e HMAC no serviço e no dispositivo. Leva cerca
de 40 segundos.

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

No terminal do serviço, `e` imprime o estado corrente.

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
MQTT_URL=mqtts://broker.hivemq.com:8883 npm run servico
EXIGIR_ASSINATURA=0 npm run servico # desliga o HMAC: mostra o ataque 'a' passando
```

---

## Estrutura

```
marco-03/
├── config.json                 configuração única dos três componentes
├── seguranca/
│   ├── index.js                TLS, senha (scrypt), ACL e HMAC
│   ├── gerar.js                `npm run seguranca`: CA, certificado, senhas
│   ├── acl.json                identidades e papéis (o que cada um publica/assina)
│   └── chaves-hmac.json        chaves de demonstração por dispositivo
├── contrato/
│   ├── index.js                carregamento, validação (ajv), tópicos e conexão segura
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
│   ├── teste-integracao.js     verificação automática dos 41 caminhos
│   ├── ataques.js              `npm run ataque -- <nome>`: ataques de demonstração
│   └── observador.js           segundo consumidor
└── docs/                       arquitetura, contrato, segurança e diagramas
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

# Marco 2 — Arquitetura e decisões

**Projeto:** *Não dê nem água* — cuidado assistido de plantas de interior
**Disciplina:** Software para Sistemas Ubíquos — UFG
**Integrantes:** Matheus Vieira Mendes Pacheco, Davi Duarte Neco, Bárbara Nogueira

Este documento registra o planejamento da fronteira de comunicação: componentes
envolvidos, fluxo, responsabilidades, mecanismo escolhido e condições de falha
consideradas.

---

## 1. Que fronteira foi escolhida, e por quê

A fronteira implementada é **dispositivo ↔ nuvem**.

Não é uma fronteira escolhida por conveniência. É a mesma que a Atividade 02
definiu nos itens 10 e 11, e é onde está o **risco principal declarado na
Atividade 01**: o sistema depende de conectividade, e sem rede o laço de
controle não fecha. Validar essa fronteira é validar exatamente o ponto em que o
projeto admitiu ser frágil.

O objetivo não é integrar o sistema inteiro. Os demais elementos previstos na
Atividade 01 — Alexa, tomadas inteligentes, aplicativo — permanecem fora deste
marco.

---

## 2. Componentes

| Componente | Papel | Onde vive | Implementação |
|---|---|---|---|
| `gateway-vaso` | **Produtor** | dispositivo | ESP32 no Wokwi (`produtor-esp32/`) e um substituto declarado em Node (`simulador-produtor/`) |
| broker MQTT | **Middleware** | rede | Aedes local (`broker-local/`) ou `broker.hivemq.com` |
| `servico-irrigacao` | **Consumidor** | nuvem | Node.js (`consumidor-servico/`) |
| `observador` | segundo consumidor | nuvem | Node.js (`scripts/observador.js`) — só lê |

O broker **não é** o produtor nem o consumidor: é mediação. Ele roteia por
tópico, mantém sessão e publica a *will message*. Nenhuma regra de negócio vive
nele.

### Por que existem dois produtores

O ESP32 simulado no Wokwi não alcança o `localhost` da máquina de apresentação,
então o caminho com dispositivo real exige um broker público e, com ele,
internet. O simulador em Node publica **exatamente o mesmo contrato** e fecha o
fluxo inteiro offline.

> **Declaração de substituto.** O simulador não é um dispositivo e não mede nada:
> o valor de umidade vem do teclado. Da mesma forma, no firmware do ESP32 a
> umidade do solo é representada por um **potenciômetro**, porque o Wokwi não
> possui higrômetro capacitivo. Em nenhum dos dois caminhos há aquisição da
> grandeza física real. Essa prática de declarar entradas substitutas em vez de
> disfarçá-las de medição vem dos relatórios do Marco 1 e é mantida aqui.

---

## 3. Fluxo de comunicação

```
                     gateway-vaso (PRODUTOR)
                     potenciômetro → leitura → validação local → carimbo de tempo
                              │
             telemetry/soil   │   status/heartbeat (retained + LWT)
                              ▼
                     ┌──────────────────┐
                     │   BROKER MQTT    │  middleware: roteia, mantém sessão,
                     │  Aedes / HiveMQ  │  publica o LWT em queda abrupta
                     └──────────────────┘
                              │
                              ▼
                   servico-irrigacao (CONSUMIDOR)
                   1 desserialização tolerante
                   2 versão + schema (ajv)
                   3 deduplicação por eventId
                   4 evento histórico (replayed)
                   5 validade / expiração
                   6 decisão: histerese + debounce + cooldown
                   7 comando idempotente
                              │
                     command/irrigacao
                              ▼
                     gateway-vaso  →  LED da bomba
                              │
                       ack/irrigacao
                              ▼
                   servico-irrigacao (confirmação de negócio)
```

---

## 4. Distribuição de responsabilidades

Segue a divisão já definida na Atividade 02, itens 10 e 11.

| Responsabilidade | Dispositivo | Nuvem |
|---|:---:|:---:|
| Leitura do sensor, carimbo de tempo | ✅ | |
| Validação local (faixa, sensor grudado) | ✅ | |
| Enfileiramento durante queda de rede | ✅ | |
| Idempotência e expiração **na atuação** | ✅ | |
| Atuação física | ✅ | |
| Validação de contrato e de versão | | ✅ |
| Deduplicação por `eventId` | | ✅ |
| Estado temporal e validade do dado | | ✅ |
| Regra de decisão (histerese, debounce, cooldown) | | ✅ |
| Emissão do comando | | ✅ |

A decisão **saiu** do dispositivo em relação ao Marco 1. Nos protótipos
individuais, cada ESP32 lia, decidia e atuava sozinho. Aqui o dispositivo
conserva apenas o que exige proximidade física ou proteção contra a própria
rede.

**Por que a idempotência fica no dispositivo, e não só no serviço.** Quem sofre
a consequência física é o dispositivo. Se a chave idempotente fosse verificada
apenas na nuvem, um comando reenviado por um intermediário qualquer — ou por uma
retransmissão do próprio MQTT — chegaria ao atuador sem nenhuma barreira. A
proteção tem de estar do lado em que o efeito acontece.

---

## 5. As cinco decisões

### 1. Quem produz
`gateway-vaso`. Publica dois eventos: `LeituraUmidadeSolo` (telemetria) e
`EstadoConectividade` (heartbeat). O heartbeat é publicado **sempre**, inclusive
quando não há leitura — a ausência de dado é, ela mesma, informação a reportar.

### 2. Quem consome e que efeito produz
`servico-irrigacao`. O efeito é observável em três lugares: transição de estado,
log estruturado (console e `eventos.jsonl`) e **atuação no LED da bomba** via
comando de volta.

### 3. Contrato e versionamento
Versionado em **dois níveis**:

- **no tópico** (`naodenemagua/v1/...`) — uma mudança incompatível roteia para
  outro caminho, e assinantes da v1 simplesmente não a recebem;
- **no payload** (`schemaVersion`) — o consumidor reconhece a versão e **rejeita
  explicitamente** o que não sabe interpretar, em vez de adivinhar.

Os dois níveis respondem a perguntas diferentes: o tópico decide *para quem a
mensagem vai*; o campo decide *se o receptor consegue interpretá-la*. Os schemas
estão em `contrato/v1/` e são validados em tempo de execução com ajv — inclusive
na saída: o serviço valida o próprio comando antes de publicá-lo.

### 4. Mecanismo: MQTT
Justificativa ligada a requisito, não a preferência:

| Requisito do projeto | O que MQTT oferece |
|---|---|
| **Múltiplos consumidores** — o app Android está previsto desde a Atividade 01 | Publicação e assinatura: um assinante novo não exige mudança no produtor |
| **Desacoplamento no tempo** — o dispositivo não pode depender de o serviço estar de pé | O produtor publica no broker, não no consumidor |
| **Queda precisa ser observável** — é o risco principal do projeto | *Will message* nativa: o broker anuncia a morte do cliente |
| **Assinante novo precisa do estado corrente** | Mensagem retida no tópico de status |

A prova prática está em `scripts/observador.js`: um segundo consumidor que pode
ser ligado e desligado a qualquer momento sem que produtor ou serviço saibam que
ele existe. É exatamente o lugar que o **app Android** ocupará na evolução
prevista — mais um assinante dos mesmos tópicos, sem alteração de nenhum dos dois
componentes atuais.

Uma API HTTP resolveria a consulta, mas exigiria que o dispositivo conhecesse o
endereço do serviço e que o serviço estivesse disponível no instante da medição —
os dois acoplamentos que este projeto precisa evitar.

### 5. Quem faz o quê

Cada integrante mantém no Marco 2 o perfil que negociou no Marco 1.

| Integrante | Responsabilidade | Arquivos |
|---|---|---|
| **Matheus** — comunicação e resiliência | firmware produtor, Wi-Fi/MQTT, `bootId`, LWT, buffer offline, backoff | `produtor-esp32/`, `simulador-produtor/` |
| **Bárbara** — estado temporal | schemas, validação, deduplicação, expiração de validade, máquina de estados | `contrato/`, `consumidor-servico/src/estado.js` |
| **Davi** — decisão e atuação | histerese, debounce, cooldown, comando idempotente, atuação e ack | `consumidor-servico/src/decisao.js`, recepção de comando no firmware |

---

## 6. Como o Marco 1 foi reaproveitado

A integração não copiou os três protótipos para dentro de um programa só. Cada
recorte individual foi **transposto para o lugar arquitetural que lhe cabe**.

| Decisão do Marco 1 | Origem | Onde está agora | O que mudou |
|---|---|---|---|
| Heartbeat e detecção de silêncio | comunicação e resiliência | `status/heartbeat` + *will message* | saiu do log serial e passou a atravessar a rede; a queda virou evento do broker |
| Expiração da validade do dado | estado temporal | `estado.js`, tick de 500 ms | a idade passou a ser medida no relógio do consumidor, porque o do dispositivo não é absoluto |
| Histerese + debounce + cooldown | decisão e atuação | `decisao.js` | a decisão virou um comando que atravessa a rede, e por isso ganhou identidade, prazo e chave idempotente |
| Validação de faixa e sensor grudado | decisão e atuação | firmware | permaneceu na borda: é barata e evita gastar rádio com leitura impossível |
| Declaração de entrada substituta | prática dos três relatórios | este documento e os comentários do código | mantida |

### O que a fronteira obrigou a acrescentar

Três problemas não existiam enquanto tudo rodava num microcontrolador só:

1. **Identidade entre execuções.** Os relatórios do Marco 1 registraram como
   limitação que `sequence` e `eventTimeMs` reiniciam a cada execução e não
   permitem ordenar execuções diferentes. Atravessando a rede isso deixa de ser
   inconveniente e vira ambiguidade real. O **`bootId`** é a identidade que
   faltava: `eventId = deviceId:bootId:sequence` é único de fato, e uma mudança
   de `bootId` informa ao consumidor que o dispositivo reiniciou.

2. **Repetição.** Um retry de telemetria não pode reprocessar estado; um retry
   de comando não pode irrigar duas vezes. Daí a deduplicação por `eventId` no
   consumidor e a chave idempotente no dispositivo.

3. **Atuação tardia.** Água aplicada depois já não responde à pergunta que
   originou a decisão.

---

## 7. Expiração no relógio de quem?

Esta foi a decisão menos óbvia do marco, e ela decorre de uma limitação herdada.

Não há NTP neste recorte: o dispositivo só conhece `millis()`, tempo desde o
próprio boot. Um prazo de validade gerado pelo relógio do serviço seria
**incomparável** para o dispositivo.

A solução foi ancorar o prazo no tempo do evento que originou a decisão — esse
sim está no domínio do dispositivo:

```
expiresAtDeviceMs = correlationEventTimeMs + ttlMs
```

O dispositivo compara `millis() >= expiresAtDeviceMs` usando **apenas o próprio
relógio**, sem precisar confiar no relógio de ninguém. O campo `issuedAt`, no
relógio do serviço, viaja junto para auditoria — mas não decide nada.

Pelo mesmo motivo, e na direção oposta, a **idade do dado** é medida no
consumidor pelo instante de recepção: `eventTimeMs` é relativo ao boot e não
serve para calcular validade do lado da nuvem. Cada lado mede o tempo com o
relógio que possui.

---

## 8. Entrega, decisão e confirmação

O QoS 1 do MQTT garante que o pacote chegou ao broker e ao assinante. Ele **não**
diz que a mensagem foi validada, que a regra decidiu atuar, nem que a bomba
ligou.

Por isso existe a `ConfirmacaoAtuacao`, com quatro resultados possíveis:

| `result` | Significado |
|---|---|
| `EXECUTADO` | a regra do dispositivo aceitou e a atuação ocorreu |
| `IGNORADO_DUPLICADO` | `idempotencyKey` já aplicada — efeito **não** repetido |
| `REJEITADO_EXPIRADO` | chegou depois de `expiresAtDeviceMs` |
| `REJEITADO_CONTRATO` | versão ou campos não interpretáveis |

### Uma suposição deliberada sobre o efeito

Ao publicar um pulso, o serviço **já se considera responsável por uma irrigação
em curso**, antes de qualquer confirmação. A confirmação serve para *corrigir
essa suposição para baixo*, não para estabelecê-la.

O motivo: se o serviço só acreditasse na irrigação ao receber o ack, um ack
perdido o deixaria convencido de que nada acontece no vaso — e ele nunca
revogaria a irrigação ao perder a validade do dado. Diante do silêncio, a
suposição segura sobre uma consequência **física** é a de que ela ocorreu.

Este comportamento não foi projetado em abstrato: ele foi descoberto porque o
teste de integração falhou exatamente nesse ponto (o `PARAR_IRRIGACAO` por
expiração não era emitido) e a correção obrigou a explicitar a política.

---

## 9. Condições de falha

Quatro condições foram implementadas e são exercitáveis. O enunciado exige pelo
menos uma.

| | Falha | Como provocar | Comportamento esperado |
|---|---|---|---|
| **F1** | Queda do dispositivo / da rede | tecla `k` no simulador, ou fechar o broker | o broker publica o **LWT**; o serviço entra em `DISPOSITIVO_OFFLINE` e revoga a autorização. O dispositivo continua amostrando, **enfileira** e reconecta com backoff; ao voltar, reenvia como `replayed` |
| **F2** | Retry de comando | republicar o mesmo comando | dispositivo responde `IGNORADO_DUPLICADO`; **o LED não pulsa de novo** |
| **F3** | Comando expirado | `COMANDO_TTL_MS=1` | dispositivo responde `REJEITADO_EXPIRADO`; não atua tarde |
| **F4** | Payload fora do contrato | teclas `x`, `v`, `i` no simulador | rejeição explícita e logada; o serviço **continua vivo** |

**F1 e F2 são as recomendadas para a demonstração** — F1 porque é o risco
declarado do projeto desde a Atividade 01, F2 porque é visualmente inequívoco: o
LED simplesmente não acende.

### Silêncio não é normalidade

Duas proteções independentes cobrem a queda, de propósito:

- o **LWT** avisa em segundos, mas só funciona se a conexão do dispositivo
  realmente cair;
- a **expiração por tempo** funciona sempre, inclusive quando o dispositivo
  continua conectado e apenas parou de medir — caso em que o LWT nunca dispara.

Uma não substitui a outra.

### Eventos históricos

Uma leitura reenviada do buffer offline chega com `replayed: true`. O consumidor
a registra e deduplica, mas **não** deixa que ela renove a validade do dado nem
realimente a decisão. Sem isso, uma rajada de leituras antigas chegando de uma
vez após a reconexão faria o serviço decidir sobre um passado que já não
descreve o presente. É a política de eventos atrasados da Atividade 02, item 8.

---

## 10. Alteração ao vivo

Todo parâmetro de comportamento está em `config.json` e pode ser sobrescrito por
variável de ambiente. Nenhuma alteração de comportamento exige editar código.

| Variável | Efeito |
|---|---|
| `LIMIAR_LIGA`, `LIMIAR_DESLIGA` | faixa da histerese |
| `AMOSTRAS_DEBOUNCE` | amostras para confirmar a condição |
| `COOLDOWN_MS` | intervalo mínimo entre pulsos |
| `VALIDADE_MS` | idade máxima do dado |
| `COMANDO_TTL_MS` | prazo de validade do comando |
| `DURACAO_PULSO_MS` | duração do pulso |
| `MQTT_URL` | troca o broker |
| `TOPIC_PREFIX`, `VASO_ID` | troca a identidade dos tópicos |

Quatro alterações ensaiadas:

1. **Subir `LIMIAR_LIGA`** — a bomba passa a ligar com solo mais úmido.
2. **Reduzir `VALIDADE_MS`** — o dado expira mais cedo e a autorização é
   revogada na frente de quem assiste.
3. **Ligar o `observador`** — prova o desacoplamento sem tocar em nada.
4. **Publicar com `schemaVersion: 2`** (tecla `v`) — mostra a política de
   compatibilidade.

Depois de qualquer alteração, `npm run teste` verifica em segundos se a
fronteira continua íntegra.

---

## 11. Limitações declaradas

1. **Não há aquisição física.** Potenciômetro no ESP32, teclado no simulador.
   Nenhuma umidade real foi medida.
2. **Sem NTP.** `eventTimeMs` é tempo desde o boot, não instante absoluto.
3. **Sem TLS e sem autenticação.** O broker público é aberto; qualquer um pode
   assinar e publicar nos tópicos. A Atividade 02 previa MQTT sobre TLS com
   credenciais por dispositivo, e isso **não** foi implementado neste marco. O
   sufixo do tópico reduz colisão, não é segurança.
4. **Um vaso apenas.** O contrato prevê `vasoId` no tópico, mas o serviço mantém
   estado de um vaso só.
5. **Estado em memória.** Reiniciar o serviço perde o estado corrente; apenas o
   `eventos.jsonl` sobrevive.
6. **O LED representa a bomba.** Não há água nem realimentação física.
7. **Alexa, tomadas inteligentes e aplicativo** permanecem fora deste marco.
8. **O Android é evolução prevista, não entrega.** A arquitetura foi escolhida
   para acomodá-lo como segundo assinante, e `scripts/observador.js` ocupa hoje
   esse lugar — mas o aplicativo não existe.

---

## 12. Uso de IA generativa

**Ferramenta:** Claude (Anthropic), via Claude Code.

**Onde foi usada:** planejamento da fronteira a partir dos slides da Aula 05 e do
enunciado do Marco 2; estruturação do repositório; redação do contrato, do código
do broker, do serviço, do simulador e do firmware; redação desta documentação.

**Erro encontrado na própria ferramenta durante a implementação.** O teste de
integração acusou falha na revogação da irrigação por expiração: o serviço
condicionava o estado da bomba ao recebimento do ack, e sem ack nunca revogava.
A correção — assumir o efeito na emissão e deixar a confirmação corrigi-lo para
baixo — está na seção 8. O defeito só apareceu ao **executar**, não ao revisar o
código.

Os integrantes são responsáveis por executar, explicar e alterar a solução.

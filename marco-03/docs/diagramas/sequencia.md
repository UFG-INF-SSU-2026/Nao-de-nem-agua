# Diagramas de sequência

## 1. Caminho feliz — da leitura à atuação

Mostra o percurso completo de um evento identificado até o efeito observável,
incluindo por que as duas primeiras amostras secas **não** atuam.

```mermaid
sequenceDiagram
    autonumber
    participant D as gateway-vaso<br/>(produtor)
    participant B as broker MQTT<br/>(middleware)
    participant S as servico-irrigacao<br/>(consumidor)

    Note over D: solo comeca a secar

    D->>B: telemetry/soil<br/>eventId ...:000003  value 20%
    B->>S: entrega (QoS 1)
    Note over S: valida contrato, deduplica<br/>1a amostra seca -> AGUARDANDO
    Note over S: nenhum comando: debounce nao cumprido

    D->>B: telemetry/soil  eventId ...:000004  value 21%
    B->>S: entrega
    Note over S: 2a amostra seca -> AGUARDANDO
    Note over S: ainda nenhum comando

    D->>B: telemetry/soil  eventId ...:000005  value 22%
    B->>S: entrega
    Note over S: 3a amostra seca -> AUTORIZADO<br/>cooldown vencido

    S->>B: command/irrigacao<br/>cmd-000007  PULSO_IRRIGACAO<br/>correlationId = ...:000005<br/>expiresAtDeviceMs = 153230
    B->>D: entrega
    Note over D: chave inedita, prazo nao vencido<br/>LED DA BOMBA ACENDE
    D->>B: ack/irrigacao  result EXECUTADO
    B->>S: entrega
    Note over S: confirmacao de NEGOCIO<br/>(o PUBACK ja havia confirmado o transporte)

    Note over D: fim do pulso: LED apaga sozinho
```

## 2. Falha F2 — retry de comando

O caso do slide 24: a resposta se perde e o cliente repete. Sem chave
idempotente, o vaso receberia água duas vezes.

```mermaid
sequenceDiagram
    autonumber
    participant S as servico-irrigacao
    participant B as broker MQTT
    participant D as gateway-vaso

    S->>B: command/irrigacao  cmd-000007
    B->>D: entrega
    Note over D: chave inedita -> BOMBA LIGA
    D-->>B: ack EXECUTADO
    B--xS: resposta se perde

    Note over S: sem confirmacao, reenvia o MESMO comando

    S->>B: command/irrigacao  cmd-000007 (retry)
    B->>D: entrega
    Note over D: idempotencyKey JA APLICADA<br/>LED NAO acende de novo
    D->>B: ack IGNORADO_DUPLICADO
    B->>S: entrega
    Note over S: efeito nao repetido, e o servico fica sabendo
```

## 3. Falha F1 — queda abrupta e recuperação

Duas proteções agem aqui, e por motivos diferentes: o LWT avisa depressa, mas só
existe se a conexão cair; a expiração por tempo funciona sempre, inclusive se o
dispositivo continuar conectado e apenas parar de medir.

```mermaid
sequenceDiagram
    autonumber
    participant D as gateway-vaso
    participant B as broker MQTT
    participant S as servico-irrigacao

    Note over D,B: no CONNECT, o dispositivo registrou a will message

    D->>B: telemetry/soil  (fluxo normal)
    B->>S: entrega

    Note over D: queda abrupta<br/>(sem DISCONNECT)
    D--xB: conexao encerrada

    B->>S: status/heartbeat  state OFFLINE<br/>publicado PELO BROKER (LWT)
    Note over S: DISPOSITIVO_OFFLINE<br/>autorizacao revogada
    S->>B: command/irrigacao  PARAR_IRRIGACAO

    Note over D: continua amostrando<br/>e ENFILEIRA localmente<br/>preservando o eventTimeMs original

    Note over D,B: reconexao com backoff (1s, 2s, 4s...)
    D->>B: CONNECT
    D->>B: telemetry/soil  replayed:true (fila)
    B->>S: entrega
    Note over S: evento HISTORICO:<br/>registra e deduplica,<br/>mas NAO renova validade nem decide

    D->>B: telemetry/soil  (leitura corrente)
    B->>S: entrega
    Note over S: contagem de amostras secas<br/>REINICIA apos a descontinuidade
```

## 4. Estados do consumidor

```mermaid
stateDiagram-v2
    [*] --> DESCONHECIDO

    DESCONHECIDO --> NORMAL: leitura valida >= limiar
    DESCONHECIDO --> AGUARDANDO: leitura valida < limiar

    NORMAL --> AGUARDANDO: 1a amostra seca
    AGUARDANDO --> AGUARDANDO: 2a amostra seca
    AGUARDANDO --> AUTORIZADO: 3a amostra seca (debounce cumprido)
    AGUARDANDO --> NORMAL: leitura acima do limiar
    AUTORIZADO --> NORMAL: umidade > limiarDesliga (histerese)

    NORMAL --> DADO_OBSOLETO: idade >= VALIDADE_MS
    AGUARDANDO --> DADO_OBSOLETO: idade >= VALIDADE_MS
    AUTORIZADO --> DADO_OBSOLETO: idade >= VALIDADE_MS

    NORMAL --> LEITURA_INVALIDA: valid false
    AUTORIZADO --> LEITURA_INVALIDA: valid false

    AUTORIZADO --> DISPOSITIVO_OFFLINE: LWT
    NORMAL --> DISPOSITIVO_OFFLINE: LWT

    DADO_OBSOLETO --> AGUARDANDO: nova leitura (contagem reinicia)
    LEITURA_INVALIDA --> AGUARDANDO: nova leitura valida
    DISPOSITIVO_OFFLINE --> AGUARDANDO: dispositivo volta

    note right of DADO_OBSOLETO
        Valor antigo PRESERVADO
        para diagnostico,
        autorizacao REVOGADA.
    end note

    note right of DISPOSITIVO_OFFLINE
        Estado que nao existia
        no Marco 1: so e alcancavel
        porque agora ha uma rede
        que pode cair.
    end note
```

Os quatro estados de falha — `DESCONHECIDO`, `DADO_OBSOLETO`,
`LEITURA_INVALIDA` e `DISPOSITIVO_OFFLINE` — têm o mesmo efeito sobre a atuação:
nenhuma irrigação é autorizada, e uma irrigação em curso é interrompida.

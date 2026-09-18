# Diagrama de componentes

Esboço arquitetural da fronteira do Marco 2. Cada caixa é um processo
executável; cada seta é uma publicação ou assinatura MQTT.

```mermaid
flowchart TB
    subgraph DISP["DISPOSITIVO — gateway-vaso (PRODUTOR)"]
        POT["Potenciometro GPIO34<br/>entrada substituta do solo"]
        FW["Firmware<br/>leitura, validacao local,<br/>carimbo de tempo, bootId"]
        BUF[("Buffer offline<br/>24 leituras<br/>preserva eventTimeMs")]
        IDEM["Idempotencia + expiracao<br/>na recepcao de comando"]
        LED(["LED da bomba<br/>GPIO26"])
        POT --> FW
        FW --> BUF
        IDEM --> LED
    end

    subgraph MID["MIDDLEWARE"]
        BROKER{{"Broker MQTT<br/>Aedes local ou HiveMQ<br/>roteia, mantem sessao,<br/>publica o LWT"}}
    end

    subgraph NUVEM["NUVEM — servico-irrigacao (CONSUMIDOR)"]
        VAL["1-2 Desserializacao tolerante<br/>versao + schema (ajv)"]
        DEDUP["3 Deduplicacao por eventId"]
        HIST["4 Evento historico<br/>replayed: arquiva, nao decide"]
        EXP["5 Validade / expiracao<br/>tick de 500 ms"]
        DEC["6 Decisao<br/>histerese + debounce + cooldown"]
        CMD["7 Comando idempotente<br/>com correlacao e prazo"]
        LOG[("eventos.jsonl<br/>cadeia da decisao")]
        VAL --> DEDUP --> HIST --> EXP --> DEC --> CMD
        DEC -.-> LOG
    end

    subgraph EXTRA["SEGUNDO CONSUMIDOR"]
        OBS["observador<br/>somente leitura"]
        AND["app Android<br/>evolucao prevista"]
    end

    FW -- "telemetry/soil" --> BROKER
    FW -- "status/heartbeat<br/>retained + LWT" --> BROKER
    BUF -. "replayed apos reconexao" .-> BROKER

    BROKER --> VAL
    CMD -- "command/irrigacao" --> BROKER
    BROKER -- "command/irrigacao" --> IDEM
    IDEM -- "ack/irrigacao" --> BROKER
    BROKER --> VAL

    BROKER -.-> OBS
    BROKER -.-> AND

    style AND stroke-dasharray: 5 5
    style BROKER fill:#e8f0fe
```

O app Android aparece tracejado porque **não é entrega deste marco**. Ele está
no diagrama para deixar visível a razão de ter sido escolhido um mecanismo de
publicação e assinatura: acrescentá-lo é acrescentar um assinante, sem tocar no
produtor nem no serviço. O `observador` ocupa hoje exatamente esse lugar e prova
a afirmação ao vivo.

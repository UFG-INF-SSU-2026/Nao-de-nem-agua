# Diagrama de componentes

Esboço arquitetural da fronteira. Cada caixa é um processo executável; cada
seta é uma publicação ou assinatura MQTT. A base é a do Marco 2; o par
**serviço → notificador** (Marco 3) aparece em destaque: o serviço **consome**
telemetria e **produz** comandos e alertas, e o notificador consome os alertas.
Explicação completa em [`marco-04.md`, §6](../marco-04.md#6-o-segundo-par-produtor-consumidor-serviço--notificador).
Os sensores e atuadores do Marco 4 usam os mesmos ramos (`telemetry/#`,
`command/atuador`, `ack/atuador`) e estão descritos no `marco-04.md`.
O banco **TimescaleDB** (Marco 4) guarda o histórico, o estado das regras e o
cadastro; o serviço continua decidindo se ele cair. Ver [`persistencia.md`](../persistencia.md).

**Marco 4 — aplicativo (entregue).** O app Android é **mais um cliente do
broker** — lê o estado retido, os alertas e o heartbeat; **produz** a luz medida
pelo celular e os pedidos de reconhecimento de falha — e lê o histórico por uma
**API HTTPS somente leitura** sobre o banco. Ver [`aplicativo.md`](../aplicativo.md).

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

    subgraph NUVEM["NUVEM — servico-irrigacao (CONSUMIDOR de telemetria, PRODUTOR de comandos e alertas)"]
        VAL["1-2 Desserializacao tolerante<br/>versao + schema (ajv)"]
        DEDUP["3 Deduplicacao por eventId"]
        HIST["4 Evento historico<br/>replayed: arquiva, nao decide"]
        EXP["5 Validade / expiracao<br/>tick de 500 ms"]
        DEC["6 Decisao<br/>histerese + debounce + cooldown"]
        CMD["7 Comando idempotente<br/>com correlacao e prazo"]
        ALR["Alerta de cuidado (Marco 3)<br/>so em transicao, eventId,<br/>correlationId, TTL"]
        LOG[("eventos.jsonl<br/>cadeia da decisao")]
        VAL --> DEDUP --> HIST --> EXP --> DEC --> CMD
        DEC --> ALR
        DEC -.-> LOG
        ALR -.-> LOG
        R5["R1-R5 (Marco 4)<br/>ar, irrigacao verificada,<br/>adubacao, reservatorios, LUZ"]
        APPS["Pedido do app<br/>RECONHECER_FALHA<br/>idempotente, com prazo"]
        EST["EstadoVaso<br/>retido, pulso de 5 s"]
        DEC --> EST
        APPS --> DEC
        R5 --> ALR
        DB[("TimescaleDB (Marco 4)<br/>historico em hypertables,<br/>estado das regras, cadastro")]
        CMD -.-> DB
        ALR -.-> DB
        DB -. "estado restaurado na partida,<br/>perfil da especie/grupo/vaso" .-> DEC
    end

    subgraph NOTIF["CONSUMIDOR DE ALERTAS (Marco 3)"]
        NOT["notificador<br/>valida, deduplica, expira<br/>ACL: so le alert/#"]
    end

    subgraph CEL["CELULAR — app Android (Marco 4): CONSUMIDOR e PRODUTOR"]
        AND["app Kotlin/Compose<br/>identidade app-vaso-01<br/>abas Vaso, Alertas, Historico"]
        LUZ["sensor de luz TCS3701<br/>media a cada 5 s"]
        LUZ --> AND
    end

    subgraph APIH["API DE HISTORICO (Marco 4)"]
        API["api-historico :8443<br/>HTTPS, Basic, so GET<br/>papel app, proprio vaso"]
    end

    subgraph EXTRA["DIAGNOSTICO"]
        OBS["observador<br/>le tudo, nao valida"]
    end

    FW -- "telemetry/soil" --> BROKER
    FW -- "status/heartbeat<br/>retained + LWT" --> BROKER
    BUF -. "replayed apos reconexao" .-> BROKER

    BROKER --> VAL
    CMD -- "command/irrigacao" --> BROKER
    BROKER -- "command/irrigacao" --> IDEM
    IDEM -- "ack/irrigacao" --> BROKER
    BROKER --> VAL

    ALR == "alert/cuidado<br/>QoS 1, nao retido" ==> BROKER
    BROKER == "alert/#" ==> NOT

    BROKER -.-> OBS

    BROKER == "state/vaso (retido), alert/#,<br/>app/resposta, status/heartbeat" ==> AND
    AND == "telemetry/light (LeituraLuz)<br/>app/solicitacao" ==> BROKER
    BROKER --> APPS
    BROKER --> R5
    EST == "state/vaso" ==> BROKER
    AND -- "HTTPS GET /historico, /alertas" --> API
    API -- "SELECT (leitor_app)" --> DB

    style AND fill:#e3f2fd
    style API fill:#e3f2fd
    style BROKER fill:#e8f0fe
    style NOT fill:#fff4d6
    style ALR fill:#fff4d6
    style DB fill:#e6f4ea
```

Até o Marco 3, o app aparecia tracejado, como evolução prevista: a escolha de
publicação e assinatura era justamente para que acrescentá-lo fosse acrescentar
um cliente, sem tocar no produtor. No Marco 4 isso se confirmou — o app entrou
sem mudar o dispositivo e sem mudar a regra de irrigação; o serviço ganhou só o
que é do app (estado retido, pedido/resposta, regra R5 da luz).

## Distribuição — onde cada parte roda e por quê

| Componente | Onde roda | Por que ali |
|---|---|---|
| Leitura, validação local, proteções físicas (intertravamento, reservatório crítico), idempotência e prazo do comando | **dispositivo** (ESP32 / simulador) | o que é **perigoso** precisa ser impedido mesmo sem rede |
| Broker MQTT (TLS, usuário/senha, ACL) | **servidor local** (PC) | ponto único por onde toda mensagem passa: lugar certo para barrar quem não deveria falar |
| Estado, regras R1–R5, decisão, alertas, estado retido para o app | **serviço** no servidor | o que é **desejável** decide quem vê o histórico e o contexto inteiro |
| Histórico, estado salvo, cadastro | **TimescaleDB** (Docker, só em 127.0.0.1) | sobrevive a reinício; só o serviço grava, só a API lê |
| API de histórico | **servidor**, ao lado do banco | o banco não sai da máquina; credencial do banco não vai para o celular |
| Tela, alertas, pedido de reconhecimento, **sensor de luz** | **celular** | é onde o usuário está — e o celular é o sensor de luz que fica junto da planta |
| Notificador, observador | servidor (terminal) | consumidores independentes: demonstram o desacoplamento |

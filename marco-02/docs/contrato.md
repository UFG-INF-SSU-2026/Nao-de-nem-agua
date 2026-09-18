# Contrato da fronteira — v1

Versão vigente: **1**. Schemas formais em [`contrato/v1/`](../contrato/v1),
validados em tempo de execução por [`contrato/index.js`](../contrato/index.js).

---

## Versionamento em dois níveis

| Nível | Onde | Responde a |
|---|---|---|
| Tópico | `naodenemagua/**v1**/vaso/{vasoId}/...` | *para quem esta mensagem vai* |
| Payload | campo `schemaVersion` | *o receptor consegue interpretá-la* |

Uma mudança incompatível cria `v2` no tópico: assinantes da v1 deixam de recebê-la
em vez de recebê-la e quebrar. O campo `schemaVersion` permite que o consumidor
rejeite explicitamente o que não entende, em vez de adivinhar.

**Regra de evolução.** Acrescentar campo opcional mantém a versão. Remover campo,
renomear campo, mudar unidade ou apertar faixa **exige** nova versão. Os schemas
usam `additionalProperties: false` de propósito: um campo inesperado é um erro
declarado, não algo que passa despercebido.

---

## Tópicos

| Tópico | Sentido | Evento | QoS | Retido |
|---|---|---|---|:---:|
| `naodenemagua/v1/vaso/{vasoId}/telemetry/soil` | dispositivo → serviço | `LeituraUmidadeSolo` | 1 | não |
| `naodenemagua/v1/vaso/{vasoId}/status/heartbeat` | dispositivo → serviço | `EstadoConectividade` | 1 | **sim** + LWT |
| `naodenemagua/v1/vaso/{vasoId}/command/irrigacao` | serviço → dispositivo | `ComandoIrrigacao` | 1 | não |
| `naodenemagua/v1/vaso/{vasoId}/ack/irrigacao` | dispositivo → serviço | `ConfirmacaoAtuacao` | 1 | não |

Telemetria e comando ficam em ramos separados porque têm compromissos
diferentes: telemetria pode ser frequente e tolerar perda; comando produz
consequência e a repetição é perigosa. A separação também permite autorizar cada
ramo de forma distinta quando houver autenticação.

O nome do tópico é parte da interface: mudá-lo quebra assinantes que você não
conhece.

---

## `LeituraUmidadeSolo` — telemetria

```json
{
  "schemaVersion": 1,
  "eventId": "esp32-vaso-01:b7f3a2:000042",
  "eventType": "LeituraUmidadeSolo",
  "deviceId": "esp32-vaso-01",
  "entityId": "vaso-01",
  "bootId": "b7f3a2",
  "eventTimeMs": 148230,
  "sequence": 42,
  "value": 18.4,
  "unit": "pct_simulado",
  "valid": true
}
```

| Campo | Papel |
|---|---|
| `eventId` | `deviceId:bootId:sequence`. Chave de deduplicação no consumidor |
| `bootId` | identidade da execução do dispositivo |
| `eventTimeMs` | relógio do dispositivo (`millis()`), **não** instante absoluto |
| `value` | umidade fictícia, 0–100, faixa validada |
| `valid` | resultado da validação local; `false` indica leitura suspeita |
| `replayed` | opcional; `true` quando vem do buffer offline |

**Por que `bootId` existe.** Os relatórios do Marco 1 registraram como limitação
que `sequence` e `eventTimeMs` reiniciam a cada execução e por isso não permitem
ordenar execuções diferentes sem identidade adicional. Dentro de um
microcontrolador isso era inconveniente; atravessando a rede vira ambiguidade
real — dois boots produziriam `eventId` idênticos e o consumidor descartaria
eventos legítimos como duplicatas. O `bootId` é essa identidade que faltava.

---

## `EstadoConectividade` — heartbeat

```json
{
  "schemaVersion": 1,
  "eventType": "EstadoConectividade",
  "deviceId": "esp32-vaso-01",
  "entityId": "vaso-01",
  "bootId": "b7f3a2",
  "eventTimeMs": 149730,
  "sequence": 98,
  "value": 1500,
  "unit": "ms_desde_ultimo_evento",
  "state": "ATIVO"
}
```

`state` assume `ATIVO`, `SILENCIOSO` ou `OFFLINE`.

Os dois primeiros são publicados pelo dispositivo. **`OFFLINE` só pode ter vindo
do broker**, como *will message*, quando a conexão terminou sem `DISCONNECT`.
Essa é a diferença entre *o dispositivo se despediu* e *o dispositivo morreu*.

O tópico é **retido**: um assinante que chegue depois — o observador, o futuro
app Android — conhece o estado corrente imediatamente, sem esperar o próximo
ciclo.

O heartbeat é publicado mesmo quando não há telemetria. A ausência de dado é ela
mesma uma informação a reportar, em vez de silêncio total no barramento.

---

## `ComandoIrrigacao` — comando

```json
{
  "schemaVersion": 1,
  "commandId": "cmd-000007",
  "idempotencyKey": "cmd-000007",
  "commandType": "ComandoIrrigacao",
  "targetId": "vaso-01",
  "action": "PULSO_IRRIGACAO",
  "durationMs": 3000,
  "correlationId": "esp32-vaso-01:b7f3a2:000042",
  "correlationEventTimeMs": 148230,
  "ttlMs": 5000,
  "expiresAtDeviceMs": 153230,
  "issuedAt": "2026-09-18T14:32:11.482-03:00",
  "reason": "umidade_abaixo_do_limiar_liga"
}
```

| Campo | Papel |
|---|---|
| `commandId` | identidade única do comando |
| `idempotencyKey` | reenvio com a mesma chave **não** repete o efeito |
| `correlationId` | `eventId` da telemetria que originou a decisão |
| `correlationEventTimeMs` | tempo daquele evento, no relógio **do dispositivo** |
| `expiresAtDeviceMs` | `correlationEventTimeMs + ttlMs` |
| `issuedAt` | relógio do serviço; auditoria apenas, não decide expiração |
| `reason` | por que a regra decidiu assim |

**Por que a expiração é expressa no relógio do dispositivo.** Sem NTP, o
dispositivo não tem como interpretar um instante gerado pelo relógio do serviço.
Ancorando o prazo no tempo do evento que originou a decisão — que está no domínio
do dispositivo — a verificação vira `millis() >= expiresAtDeviceMs`, feita
inteiramente com o relógio local. Cada lado mede o tempo com o relógio que
possui.

---

## `ConfirmacaoAtuacao` — confirmação de negócio

```json
{
  "schemaVersion": 1,
  "eventType": "ConfirmacaoAtuacao",
  "deviceId": "esp32-vaso-01",
  "bootId": "b7f3a2",
  "commandId": "cmd-000007",
  "correlationId": "esp32-vaso-01:b7f3a2:000042",
  "result": "EXECUTADO",
  "appliedAtDeviceMs": 148612,
  "detail": "PULSO_IRRIGACAO"
}
```

| `result` | Significado |
|---|---|
| `EXECUTADO` | a atuação ocorreu |
| `IGNORADO_DUPLICADO` | chave já aplicada; efeito **não** repetido |
| `REJEITADO_EXPIRADO` | chegou após `expiresAtDeviceMs` |
| `REJEITADO_CONTRATO` | versão ou campos não interpretáveis |

Um `PUBACK` do MQTT diz que o pacote chegou. Este evento diz o que a regra fez
com ele. São perguntas diferentes, e só a segunda responde *"a bomba ligou?"*.

---

## Qualidade dos eventos

Herdado da Atividade 02, item 4, e verificado em `npm run teste`.

| Problema | Como é reconhecido | O que acontece |
|---|---|---|
| Fora de faixa | schema (`value` em 0–100) | rejeitado e logado; não decide |
| Versão desconhecida | `schemaVersion` ≠ 1 | rejeitado com motivo específico |
| Campo inesperado | `additionalProperties: false` | rejeitado |
| JSON malformado | desserialização tolerante | rejeitado; **o serviço não cai** |
| Duplicado | `eventId` já visto | descartado sem reprocessar estado |
| Desatualizado | idade ≥ `VALIDADE_MS` | `DADO_OBSOLETO`; autorização revogada |
| Atrasado (replay) | `replayed: true` | arquivado; não renova validade nem decide |
| Leitura suspeita | `valid: false` do dispositivo | `LEITURA_INVALIDA`; não decide |

O valor antigo é **preservado** em `DADO_OBSOLETO`, para diagnóstico. Guardar um
valor e afirmar que ele é atual são coisas diferentes.

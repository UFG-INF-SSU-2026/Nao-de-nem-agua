# Marco 4 — sensores, atuadores e regras novos

**Projeto:** *Não dê nem água* — cuidado assistido de plantas de interior
**Disciplina:** Software para Sistemas Ubíquos — UFG
**Integrantes:** Matheus Vieira Mendes Pacheco, Davi Duarte Neco, Bárbara Nogueira

O feedback do Marco 3 pediu **mais sensores** e uma solução **mais complexa**.
Este marco atende ao pedido **sem trocar a arquitetura**: tudo o que é novo
atravessa a mesma fronteira dispositivo ↔ nuvem do Marco 3, com os mesmos
compromissos (TLS, HMAC, contrato versionado, comando idempotente com prazo no
relógio do dispositivo, ack de negócio). O dispositivo continua medindo,
validando e atuando; o serviço continua guardando o estado e decidindo.

---

## 1. O que entrou

### Sensores

| Sensor | Onde | Grandeza | Real ou simulado |
|---|---|---|---|
| **Sonda de solo 3-em-1** | custom chip `sonda-solo` (Wokwi) | umidade (%), temperatura do substrato (°C), **condutividade elétrica** (µS/cm) = nutrientes | **Simulado** — o Wokwi não tem higrômetro nem sensor de EC; o chip foi escrito pelo grupo e os valores vêm de sliders |
| **DHT22** | GPIO 15 | temperatura e umidade do ar | componente do Wokwi (valor por slider) |
| **HC-SR04 ×2** | GPIO 5/18 e 17/16 | distância até a superfície → nível do reservatório de **água** e de **fertilizante** | componente do Wokwi (valor por slider) |

> **Declaração de substituto.** A sonda 3-em-1 substitui o potenciômetro dos
> marcos anteriores. Ela não mede nada: é um programa (`sonda-solo.chip.c`) que
> converte sliders em tensões. O que ela tem de útil é um **modelo físico
> declarado** — a EC que a sonda "enxerga" cai com o solo seco e sobe ~2 %/°C —
> e **falhas injetáveis** (desconectada, oxidada/travada, ruidosa). Isso obriga
> o firmware a compensar a leitura e a diagnosticar o sensor, em vez de só ler
> um número.

### Atuadores

| Atuador | Pino | Comando | Natureza |
|---|---|---|---|
| Bomba de água | GPIO 26 (relé) | `ComandoIrrigacao` (Marco 3) | pulso |
| **Bomba de fertilizante** | GPIO 27 (relé) | `ComandoAtuador` `BOMBA_ADUBO` `PULSO`/`DESLIGAR` | dose |
| **Umidificador** | GPIO 33 (relé) | `ComandoAtuador` `UMIDIFICADOR` `LIGAR`/`DESLIGAR` | **concessão** com prazo |
| LED de proteção local | GPIO 13 | — | aceso quando o dispositivo está bloqueando algo por conta própria |

---

## 2. Onde cada coisa roda

Mesma divisão da Atividade 02 (itens 10 e 11) e do Marco 3, estendida:

| Responsabilidade | Dispositivo | Serviço |
|---|:---:|:---:|
| Conversão da sonda, compensação da EC por temperatura e umidade | ✅ | |
| Diagnóstico da sonda (desconectada, fora da faixa, **travada**, **ruidosa**) | ✅ | |
| Mediana do ultrassom e nível em % | ✅ | |
| **Proteções físicas** (ver §4) | ✅ | |
| Média do ar, validade de cada dado, estados dos reservatórios | | ✅ |
| Regras R1–R4 e alertas | | ✅ |
| Verificação do **efeito** de cada atuação | | ✅ |

A regra que decide **o que é desejável** fica na nuvem. A regra que impede
**o que é perigoso** fica no dispositivo — é ele que tem o sensor e sofre a
consequência física, e ele precisa continuar seguro sem rede. É o mesmo
argumento que o Marco 3 usou para manter a idempotência no dispositivo.

---

## 3. Regras no serviço

### R1 — umidade do ar → umidificador (`ambiente.js`)

- Média móvel das últimas 3 leituras; validade de 10 s (relógio do serviço).
- Liga abaixo de 50 %; desliga acima de 60 % (histerese); tempo mínimo entre
  trocas de 6 s.
- **O `LIGAR` é uma concessão** (`durationMs` = 30 s). O dispositivo desliga
  sozinho quando ela vence; o serviço a renova na metade do prazo enquanto a
  condição durar. Se o serviço, o broker ou o dado sumirem, o umidificador não
  fica ligado para sempre — é o "silêncio não é normalidade" do Marco 3 aplicado
  a um atuador contínuo.
- DHT22 com `valid:false` → `DESLIGAR` + alerta `SENSOR_FALHOU`.

### R2 — irrigação (Marco 3 + `verificacao.js`)

A histerese, o debounce e o cooldown do Marco 3 não mudaram. Entraram três
coisas, todas via um `contexto` opcional em `decidir()` (sem contexto, o
comportamento é idêntico ao do Marco 3 — os 62 testes antigos continuam
passando):

1. **Bloqueio por reservatório:** com o reservatório de água `CRITICO`, o
   serviço não pede irrigação e, se a bomba estiver ligada, manda parar.
2. **Pedido da R3:** a adubação pode pedir água para preparar o solo.
3. **Verificação cruzada do efeito.** O Marco 3 distinguia *entregue* (PUBACK)
   de *executado* (ack). O Marco 4 pergunta **"a água chegou?"** — e responde
   com dois sensores independentes:

   | umidade subiu ≥ 3 pts | nível caiu ≥ 1 pt | diagnóstico |
   |:---:|:---:|---|
   | sim | sim | efeito confirmado |
   | não | não | `bomba_sem_fluxo` |
   | não | sim | `agua_nao_chegou_ao_vaso` (mangueira, vazamento) |
   | sim | não | `sensor_nivel_suspeito` |

   Sem confirmação em 15 s: alerta `FALHA_IRRIGACAO` (CRÍTICO) e **irrigação
   automática bloqueada** até reconhecimento (tecla `r` no serviço — o lugar do
   botão do app) ou por 2 min. Ligar de novo uma bomba que não bombeia só a
   queima.

### R3 — adubação (`adubacao.js`)

```
OCIOSO ──(gatilho; limite de doses ok; cooldown ok)
  ├─ solo < 35 % ──► AGUARDANDO_IRRIGACAO (pede água à R2) ──► AGUARDANDO_ABSORCAO ──► MEDINDO
  └─ solo na faixa ──────────────────────────────────────────────────────────────► MEDINDO
MEDINDO (média de 3 leituras de EC válidas, coletadas AGORA)
  ├─ ainda < 800 µS/cm ──► DOSANDO ──(ack EXECUTADO)──► VERIFICANDO
  └─ ≥ 800 ──────────────► OCIOSO  "falso_positivo_evitado"
VERIFICANDO ──(EC subiu ≥ 100 E nível do adubo caiu)──► OCIOSO + ADUBACAO_EXECUTADA
            ──(prazo)──► BLOQUEADA + FALHA_ADUBACAO
```

- **Dois gatilhos.** (A) EC compensada abaixo do mínimo. (B) *Suspeita*: com o
  solo seco a EC não é confiável (`ecValid:false`), mas a EC aparente está
  baixa. Pode ser só falta de água — por isso a R3 irriga, espera absorver e
  **mede de novo** antes de decidir. É o cenário em que um sistema ingênuo
  adubaria sem necessidade.
- **Nunca adubar solo seco** (queima a raiz), **no máximo 1 dose por janela**
  (7 dias em produção; 60 s na configuração de demonstração), **cooldown** entre
  tentativas.
- Sem ack no prazo, a dose é **assumida como aplicada** e conta no limite — a
  mesma suposição segura do Marco 3 para efeitos físicos.
- EC acima de 2000 µS/cm → `EXCESSO_NUTRIENTES`. O sistema **não atua**: a
  correção (lavar o substrato) é do usuário.

### R4 — reservatórios (`reservatorios.js`)

`OK` (> 25 %) / `BAIXO` (≤ 25 %) / `CRITICO` (≤ 10 %), com 3 pts de histerese
para sair de um estado pior. Alertas `RESERVATORIO_BAIXO`,
`RESERVATORIO_CRITICO` e `RESERVATORIO_NORMALIZADO`. Com o dado vencido, o
estado volta a `DESCONHECIDO` e o serviço **não bloqueia sozinho**: quem barra a
bomba a seco é o dispositivo, que tem o sensor.

---

## 4. Proteções físicas no dispositivo

Valem com ou sem rede e diante de **qualquer** comando, inclusive autêntico,
assinado e no prazo. Violação → ack `REJEITADO_SEGURANCA` com o motivo em
`detail` (e a chave idempotente **não** é registrada: se a condição mudar, um
reenvio é avaliado de novo).

| Comando | Recusado quando | `detail` |
|---|---|---|
| `PULSO_IRRIGACAO` | nível de água ≤ 10 % ou desconhecido | `reservatorio_agua_critico` / `nivel_agua_desconhecido` |
| | bomba de adubo ligada | `intertravamento_bomba_adubo` |
| `BOMBA_ADUBO PULSO` | nível de adubo ≤ 10 % ou desconhecido | `reservatorio_adubo_critico` / `nivel_adubo_desconhecido` |
| | bomba de água ligada | `intertravamento_bomba_agua` |
| | solo < 35 % ou sonda inválida | `solo_seco_nao_adubar` / `sonda_solo_invalida` |
| `UMIDIFICADOR LIGAR` | DHT22 com 3 falhas seguidas | `sensor_ar_invalido` |

E, a cada volta do `loop()`: a bomba para se o reservatório chegar ao crítico
no meio do pulso; o umidificador desliga se a concessão vencer ou o DHT22
falhar; dose e concessão têm teto (10 s e 120 s) mesmo que o comando peça mais.

---

## 5. Contrato — o que mudou na v1

Seguindo a regra de evolução do `contrato.md`: **acrescentar** mantém a versão;
nada foi removido, renomeado ou apertado.

| Mudança | Tipo | Tópico |
|---|---|---|
| `LeituraAmbiente` (novo) | evento novo | `.../telemetry/ambient` |
| `NivelReservatorio` (novo) | evento novo | `.../telemetry/reservoir` |
| `ComandoAtuador` (novo) | comando novo | `.../command/atuador` |
| `ConfirmacaoAtuacao` em `ack/atuador` | mesmo schema, tópico novo | `.../ack/atuador` |
| `LeituraUmidadeSolo` + `soilTempC`, `ecApparentUsCm`, `ec25UsCm`, `ecValid`, `ecInvalidReason` | campos **opcionais** | inalterado |
| `ConfirmacaoAtuacao.result` + `REJEITADO_SEGURANCA` | valor novo (como `REJEITADO_ASSINATURA` no Marco 3) | — |
| `AlertaCuidado.alertType` + 11 tipos | valores novos | inalterado |

**Por que `command/atuador` e não mais ações em `command/irrigacao`.** O nome do
tópico é parte da interface: um assinante do Marco 3 que escuta
`command/irrigacao` espera bomba de água. Pôr o umidificador ali mudaria o
significado de um tópico existente. Em ramo próprio, a ACL também autoriza cada
coisa separadamente (`seguranca/acl.json`).

**`sequence` único.** Solo, ar e nível usam o mesmo contador, então
`eventId = deviceId:bootId:sequence` continua único entre os três e o serviço
deduplica todos com o mesmo conjunto.

**Schemas condicionais.** `LeituraAmbiente` e `NivelReservatorio` só exigem os
valores quando `valid:true` — sem leitura confiável, o número é **omitido**,
nunca inventado. `ComandoAtuador` restringe as ações por atuador (`LIGAR` não
existe para a bomba de adubo; `PULSO` não existe para o umidificador).

### Exemplos

```json
{"schemaVersion":1,"eventId":"esp32-vaso-01:a1b2c3:000041","eventType":"LeituraUmidadeSolo",
 "deviceId":"esp32-vaso-01","entityId":"vaso-01","bootId":"a1b2c3","eventTimeMs":61500,"sequence":41,
 "value":55.0,"unit":"pct_simulado","valid":true,
 "soilTempC":24.0,"ecApparentUsCm":449,"ecValid":true,"ec25UsCm":500,"sig":"…"}
```

```json
{"schemaVersion":1,"commandId":"atu-000003","idempotencyKey":"atu-000003","commandType":"ComandoAtuador",
 "targetId":"vaso-01","actuator":"BOMBA_ADUBO","action":"PULSO","durationMs":2000,
 "correlationId":"esp32-vaso-01:a1b2c3:000047","correlationEventTimeMs":70500,
 "ttlMs":5000,"expiresAtDeviceMs":75500,"issuedAt":"2026-11-23T14:02:11.482Z",
 "reason":"ec_abaixo_minimo","sig":"…"}
```

---

## 6. Como demonstrar

**Caminho A (local, recomendado):** os quatro terminais do README. No simulador:

| Tecla | O que observar |
|---|---|
| `h` | ar a 35 % → `UMIDIFICADOR LIGAR` (concessão) → ar sobe → `DESLIGAR` |
| `z` | DHT22 falha → `SENSOR_FALHOU`, umidificador desliga |
| `r` depois `s` | reservatório crítico → `RESERVATORIO_CRITICO`; solo seco **não** gera pulso |
| `w` | reabastece → irrigação volta e o log do serviço mostra `efeito confirmado` |
| `n` (com solo úmido) | EC 500 → MEDINDO → dose → `ADUBACAO_EXECUTADA` |
| `s` com EC normal | falso positivo: irriga, mede de novo e **não** aduba |
| `f` depois `s` | bomba sem fluxo → `FALHA_IRRIGACAO`, irrigação bloqueada; `r` no serviço libera |
| `b` | EC 2500 → `EXCESSO_NUTRIENTES` |

**Caminho B (Wokwi):** `produtor-esp32/` traz `sketch.ino`, `diagram.json`,
`sonda_solo.h`, `reservatorios.h` e o custom chip (`sonda-solo.chip.json` e
`sonda-solo.chip.c`). Bibliotecas: **PubSubClient** e **DHT sensor library for
ESPx**. No Wokwi não há física: quem "rega" é quem move o slider da sonda e do
HC-SR04 durante o pulso.

---

## 7. Limitações declaradas

1. **Nenhuma grandeza nova é medida de verdade.** Sonda por custom chip; DHT22 e
   HC-SR04 por slider; no simulador Node, uma física simples declarada.
2. **O firmware do Marco 4 não foi compilado nesta máquina** (sem toolchain
   ESP32 local). O formato de todas as mensagens que ele monta foi conferido
   contra os schemas, mas a primeira compilação acontece no Wokwi.
3. **O buffer offline só guarda o solo** (sem os campos de EC). Ar e nível são
   estado corrente; um replay não decide nada no serviço.
4. **Comandos de atuador ancorados em evento antigo podem chegar vencidos** —
   por exemplo o `DESLIGAR` emitido quando o dado do ar expira. É por isso que o
   umidificador funciona por concessão: ele desliga de qualquer jeito.
5. **Um vaso, uma espécie.** Os limiares (umidade do ar, EC) estão no
   `config.json`, não numa matriz por espécie.
6. **Estado em memória**, como no Marco 3: doses aplicadas e bloqueios se perdem
   se o serviço reiniciar.

---

## 8. Próximo passo: o aplicativo

O app previsto entra como **mais um assinante** dos tópicos — o lugar que o
`observador` ocupa hoje —, sem mudar produtor nem serviço. Ele herda
naturalmente: o estado dos reservatórios, os alertas novos e o
**reconhecimento de falha** (hoje a tecla `r` do serviço), que precisará de um
comando próprio do app para o serviço. O sensor do celular previsto é o de
**luz ambiente** (Android `Sensor.TYPE_LIGHT`, em lux), para escolher o melhor
lugar do vaso e calibrar o sensor de luz do dispositivo.

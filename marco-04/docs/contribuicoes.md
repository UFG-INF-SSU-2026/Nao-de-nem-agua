# Contribuições individuais

**Projeto:** *Não dê nem água* — cuidado assistido de plantas de interior
**Disciplina:** Software para Sistemas Ubíquos (INF0483) — UFG — 2026/2
**Integrantes:** Davi Duarte Neco e Matheus Vieira Mendes Pacheco

## 1. Escopo deste documento

O PDF do Marco 4 pede, entre os documentos do repositório, as **contribuições
individuais** ao lado do artigo, das limitações e da declaração de uso de IA
(§3), e diz que cada integrante deve "compreender a arquitetura geral e explicar
sua contribuição" (§6). Como a mesma lista vale para a entrega final de 11/12,
que avalia o projeto inteiro, este documento:

- detalha as contribuições do **Marco 4** (§2 a §4), que é a entrega atual; e
- resume as dos **Marcos 1 a 3** (§5), para que a versão final cubra o projeto
  todo sem precisar ser reescrita.

## 2. Resumo da divisão no Marco 4

| Item obrigatório (PDF) | Responsável principal | Participação do outro integrante |
|---|---|---|
| Aplicativo móvel (APK, sensor de luz) | Matheus | Davi: apresentação da arquitetura do app no vídeo |
| Persistência (TimescaleDB) | Matheus | Davi: auxílio na decisão |
| Testes automatizados | Matheus (suítes de persistência, API e app; seções 19–20 da integração) | Davi: revisão da suíte, testes das regras de alerta, apresentação dos testes no vídeo |
| Documentação de implantação | Matheus | Davi: revisão |
| Relatório técnico (artigo) | Davi | Matheus: revisão |
| Atendimento ao feedback do Marco 3 (sensores, atuadores, regras R1–R4) | Davi: alertas novos e notificador | Matheus: sensores novos e revisão |
| Vídeo | os dois — Davi abre e fecha; Matheus conduz a demonstração | — |

## 3. Matheus Vieira Mendes Pacheco

**Perfil desde o Marco 1:** comunicação e resiliência.

### O que fez no Marco 4

- **Aplicativo Android** (Kotlin + Jetpack Compose): especificou as telas e o
  fluxo (login, painel, alertas, reconhecimento de falha, histórico, ajustes),
  testou cada versão no celular real e conduziu as correções de comportamento e
  de interface até o APK de release.
- **Integração do app com o sistema:** identidade e papel `app` na ACL do
  broker; contratos `EstadoVaso` (estado retido), `SolicitacaoApp` e
  `RespostaApp` (o caminho de volta que substituiu a tecla `r` do serviço);
  assinatura das mensagens do app e do serviço para o caminho público (Wokwi).
- **Sensor do celular — luz ambiente (R5):** contrato `LeituraLuz`, regra de
  alerta no serviço (média, tempo mínimo, histerese, validade) e publicação pelo
  app; ensaio e calibração com o sensor do aparelho.
- **Persistência:** TimescaleDB com hypertables e agregados contínuos, fila de
  gravação tolerante à queda do banco, snapshot e restauração do estado das
  regras, perfil de cuidado por espécie/grupo/vaso e papéis de menor privilégio
  no banco.
- **API de histórico:** API HTTPS somente leitura (`leitor_app`) consumida pela
  aba Histórico do app.
- **Sensores, atuadores e regras novos** em resposta ao feedback do Marco 3:
  sonda de solo 3-em-1 (custom chip), DHT22, dois HC-SR04, bomba de adubo,
  umidificador, regras R1–R4 e proteções locais no firmware.
- **Testes:** suítes `teste:persistencia`, `teste:api`, testes unitários do app
  e seções 19 (app) e 20 (luz) do teste de integração.
- **Fechamento:** APK de release, documentação de implantação, `aplicativo.md`,
  `persistencia.md` e roteiro da demonstração.

### Arquivos principais

`app-android/`, `api-historico/`, `persistencia/`,
`consumidor-servico/src/luz.js`, `consumidor-servico/src/ambiente.js`,
`reservatorios.js`, `verificacao.js`, `adubacao.js`, `atuadores.js`, `contrato/v1/` (schemas do app, da luz e do histórico),
`seguranca/` (papel `app` e chaves de assinatura), `produtor-esp32/`,
`simulador-produtor/`, `scripts/teste-persistencia.js`, `scripts/teste-api.js`.


Fluxo com o app (dois produtores, decisão e resposta), mudança de contexto pelo
sensor de luz, persistência, segurança e falha/recuperação 

## 4. Davi Duarte Neco

**Perfil desde o Marco 1:** decisão e atuação.

### O que fez no Marco 4

- **Alertas e notificador:** definiu as regras dos alertas novos do Marco 4
  (reservatórios, sensores, adubação, falha de irrigação), implementou partes
  delas e do notificador, e revisou e ajustou o código e os testes de cada regra
  — continuação do par serviço → notificador que ele criou no Marco 3.
- **Testes:** revisão da suíte de testes automatizados
- **Apresentação:** preparação e condução da abertura (problema, arquitetura e
  distribuição) e do fechamento (testes automatizados, limitações e feedback) do
  vídeo.
- Participação no artigo, no `feedback.md` e em
  outras partes da documentação.

### Arquivos principais

`consumidor-servico/src/alertas.js`, `notificador/src/main.js`,
`contrato/v1/alerta-cuidado.schema.json`, `docs/alertas.md`


Problema, arquitetura e distribuição; testes automatizados; limitações e
feedback —

## 5. Histórico: Marcos 1 a 3

A equipe teve três integrantes até o Marco 3. Bárbara Nogueira participou até
o Marco 3 e não integra mais a equipe.

| Etapa | Matheus | Davi | Bárbara |
|---|---|---|---|
| **Atividade 02** (modelagem) | redação de `atividade-02.md` | implementação | modelagem e tradução dos contratos de eventos |
| **Marco 1 / Atividade 03** (protótipos individuais) | heartbeat e silêncio do sensor de ambiente (LDR + DHT22, LED + buzzer) | irrigação por umidade do solo com histerese, debounce e cooldown | expiração da validade do dado do reservatório (janela de amostras) |
| **Marco 2** (fronteira dispositivo ↔ serviço) | firmware produtor, Wi-Fi/MQTT, `bootId`, LWT, buffer offline, backoff; integração da fronteira | decisão: histerese, debounce, cooldown, comando idempotente, atuação e ack | estado temporal: schemas, validação, deduplicação, expiração |
| **Marco 3** (segurança e segundo par) | TLS, autenticação, ACL e assinatura HMAC | alertas MQTT e notificador (segundo par produtor-consumidor) |  |

Fontes: histórico de commits do repositório e
[`arquitetura.md`, §5](arquitetura.md#5-quem-faz-o-quê).

## 6. Uso de IA

O uso de ferramentas de IA por integrante (Claude Code pelo Matheus, Codex pelo
Davi), com finalidade, sugestões aproveitadas e forma de validação, está em
[`uso-de-ia.md`](uso-de-ia.md). As contribuições acima incluem a especificação,
a revisão, o teste e a correção do que essas ferramentas produziram; cada
integrante responde por compreender e explicar a parte que lhe cabe e a
arquitetura geral.

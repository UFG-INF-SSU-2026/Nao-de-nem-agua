# Testes — comandos, cobertura e evidências

O PDF pede testes automatizados **executáveis, com comandos e resultados**,
relacionados aos módulos e requisitos cobertos, e o registro das verificações
manuais (passos, esperado, observado, evidência). Este documento reúne os dois.

## 1. Comandos e resultados

| Suíte | Comando | Tipo | Requer | Resultado | Evidência |
|---|---|---|---|---|---|
| Integração da fronteira | `npm run teste` | integração (processos reais, broker TLS em porta livre) | nada | **129/129** | [`teste-integracao.txt`](evidencias/teste-integracao.txt) |
| Unitários do backend | `npm run teste:unidade` | unitário (`node:test`) | nada | **48/48** | [`teste-unidade.txt`](evidencias/teste-unidade.txt) |
| Persistência | `npm run teste:persistencia` | integração com TimescaleDB real | banco | **37/37** | [`teste-persistencia.txt`](evidencias/teste-persistencia.txt) |
| API de histórico | `npm run teste:api` | integração HTTPS + banco | banco | **25/25** | [`teste-api.txt`](evidencias/teste-api.txt) |
| App Android | `gradlew testDebugUnitTest` (em `app-android`) | unitário (JUnit) | JDK do Android Studio | **30/30** | [`teste-app.txt`](evidencias/teste-app.txt) |
| **Total** | | | | **269 verificações** | |

Todos os comandos rodam na pasta `marco-04` (o do app, em `marco-04/app-android`,
com `JAVA_HOME` no JDK do Android Studio — ver [`implantacao.md`](implantacao.md), §6).

## 2. Testes × módulos

| Módulo | Arquivo(s) | Coberto por |
|---|---|---|
| Contrato e validação | `contrato/index.js`, `contrato/v1/*.schema.json` | integração §4, §14, §19, §20; unitários (LeituraLuz); app `ContratosTest`, `HistoricoTest` |
| Broker: TLS, senha, ACL | `broker-local/broker.js`, `seguranca/` | integração §9–§11, §19, §20; `teste:api` §1–§3 |
| HMAC (dispositivo ↔ serviço) | `seguranca/index.js`, firmware/simulador | integração §12, §13 |
| Assinatura das mensagens do app (HMAC do app, ECDSA do serviço; broker público) | `seguranca/index.js`, `contrato/index.js` (`abrirMensagemDoApp`), `conexao/Assinaturas.kt` | integração §19 (estado e respostas com ECDSA válida; pedido assinado atendido; HMAC de outra chave sem resposta); unitários `assinatura-app.test.js` (8); app `AssinaturasTest` (vetores gerados pelo Node) |
| Estado, validade, decisão de irrigação | `consumidor-servico/src/estado.js`, `decisao.js` | integração §1–§7; unitários (restauração) |
| Alertas | `consumidor-servico/src/alertas.js`, `notificador/` | integração §8, §18 |
| R1 ar/umidificador | `ambiente.js` | integração §15; unitários (restauração) |
| R2 verificação do efeito da irrigação | `verificacao.js` | integração §18, §19 |
| R3 adubação | `adubacao.js` | integração §17; unitários (restauração) |
| R4 reservatórios | `reservatorios.js` | integração §16 |
| **R5 luz** (app como produtor) | `luz.js` | integração §20; unitários `luz.test.js` (8) |
| Pedido do app (reconhecer falha) e estado retido | `main.js` (`tratarSolicitacaoApp`, `publicarEstadoVaso`) | integração §19 |
| Persistência (fila, snapshot, perfil) | `persistencia/` | `teste:persistencia`; unitários `fila`, `perfil`, `restauracao` |
| API de histórico | `api-historico/` | `teste:api` (25); unitários `api.test.js` (6) |
| App: conexão e diagnóstico de falhas | `conexao/ConexaoMqtt.kt`, `HistoricoApi.kt` | app `ContratosTest` (classificação de falhas, inclusive o caso do `adb reverse`); `EnderecosTest` (broker público: IPv4 antes do IPv6) |
| App: pedido, rótulos, luz, histórico | `ui/Pedido.kt`, `Rotulos.kt`, `sensor/SensorLuz.kt`, `contrato/Historico.kt` | app `PedidoTest`, `LuzTest`, `HistoricoTest` |
| Telas do app | `ui/*Tela.kt` | **manual**, no aparelho (§4) |

## 3. Requisitos do PDF × evidência

| Verificação do PDF | Automatizado | No aparelho / manual |
|---|---|---|
| **Fluxo e contexto** — dois produtores, decisão e resposta **com participação do aplicativo**; efeito de uma mudança de contexto | integração §2 (solo seco → pulso), §15–§18 (contexto ar/EC/reservatório muda a decisão), §19 (app reconhece → serviço decide de novo → pulso), §20 (o app como **segundo produtor**: luz → R5 → alerta) | [aplicativo.md §6.1](aplicativo.md#61-telas-e-reconhecimento-de-falha-fase-3), passos 8–10 (falha → reconhecimento no celular → bomba irrigando); §7.1 passos 14–17 (luz real do celular → “Pouca luz”) |
| **Persistência** — gravação, recuperação e preservação após reiniciar o componente | `teste:persistencia`: gravação nas hypertables, **SIGKILL** no serviço e restauração (doses, bloqueio, deduplicação), queda e volta do banco, dados após reiniciar o contêiner; `teste:api` §5 (recuperação pelas consultas) | aplicativo.md §7.1 passo 17 (luz no banco), §8.1 passos 20–22 (histórico de sessões anteriores e de antes do reinício do PC) |
| **Segurança** — rejeição de identidade inválida e de operação fora da permissão; canal criptografado | integração §9 (só TLS, só com a CA certa), §10 (senha errada, anônimo), §11 (ACL), §12–§13 (HMAC), §19 (app não comanda, não lê outro vaso, não falsifica `deviceId`), §20 (gateway não publica luz); `teste:api` §1–§4 e §6 (TLS e nome, 401, 403, 400, 405, 429); persistência §6 (`leitor_app` não grava) | aplicativo.md §6 passo 2 (senha errada no celular → `AUTH_RECUSADA`); `npm run ataque -- <nome>` (README) |
| **Falha e recuperação** — comportamento durante a falha e após o retorno | integração §5 (silêncio → revoga), §6 (replay), §7 (LWT), §18 (bomba sem fluxo → bloqueio → volta); `teste:persistencia` (SIGKILL, queda do banco); §20 (celular para → `SEM_MEDICAO`) | aplicativo.md §6 passos 4–5 (broker cai → “reconectando” → volta sozinho), §6.1 passos 11–12 (serviço cai → “não respondeu” → tentar de novo), §8.1 passos 23–24 (API cai → “inalcançável” → recupera) |

## 4. Verificações manuais no aparelho

Feitas num Galaxy A16 (Android 16) pelo cabo USB, com broker, serviço, banco,
simulador e API locais. Cada tabela tem **passo, esperado, observado e
evidência** (capturas em [`evidencias/app/`](evidencias/app/)):

| Fase | Onde | Passos |
|---|---|---|
| 2 — conexão segura | [aplicativo.md §6](aplicativo.md#6-verificação-no-aparelho-fase-2) | 1–6: login, senha errada, conexão, broker cai e volta, senha lembrada |
| 3 — telas e reconhecimento | [aplicativo.md §6.1](aplicativo.md#61-telas-e-reconhecimento-de-falha-fase-3) | 7–13: painel, falha real, alertas, reconhecimento de ponta a ponta, serviço fora, retry idempotente, falha + reservatório |
| 4 — sensor de luz | [aplicativo.md §7.1](aplicativo.md#71-verificação-no-aparelho-fase-4) | 14–19: luz real, bug de horário achado pelo contrato, pouca luz sustentada, banco, validade, retomada |
| 5 — histórico | [aplicativo.md §8.1](aplicativo.md#81-verificação-no-aparelho-fase-5) | 20–24: 6 h e 1 h, alertas do banco, API fora e de volta |
| 6 — APK de entrega | abaixo | 25 |

| # | Passo | Esperado | Observado |
|---|---|---|---|
| 25 | Instalar o APK de release (`entrega/naodenemagua-1.0-marco4.apk`, otimizado pelo R8) | conecta, assina, publica luz e lê o histórico como o de depuração | `AUTENTICADO … (papel app)` e `SUBSCRIBE` dos 4 filtros; `RECEBIDO app-vaso-01:…:1 luz`; API `200 /historico` e `/alertas`; nenhuma falha no `logcat -b crash` |

## 5. Bugs que os testes encontraram

| Onde | Sintoma | Causa | Correção |
|---|---|---|---|
| Fase 3, aparelho | cartão de falha mostrava “reservatório crítico” como a falha a reconhecer | o `EstadoVaso` só tinha o bloqueio **efetivo** | campo opcional `falhasPendentes` no contrato (v1 mantida); teste §19 |
| Fase 4, aparelho | serviço recusava toda `LeituraLuz` | `Instant` do Android com microssegundos; contrato aceita até milissegundos | `Contratos.utc()` no app; `LuzTest` |
| Fase 5, aparelho | “certificado não é da CA” com a API **desligada** | pelo `adb reverse`, servidor fora = handshake TLS encerrado | `classificarRede()` (app, MQTT e API); `ContratosTest` |
| Fase 4, teste | duas verificações falhavam | cores ANSI no log entre rótulo e mensagem | o teste remove as cores antes de comparar |
| Fase 3, execução concorrente | 1 falha na seção 3 (deduplicação) | máquina carregada pela compilação do app (tempo) | repetida sem carga: passou; registrado |
| Broker público, aparelho (rede 5G) | app não conectava ao HiveMQ: `ECONNREFUSED` | o DNS devolve o IPv6 do HiveMQ primeiro, ele recusa a porta 8883, e o Paho só tenta o primeiro endereço | o app tenta os IPs com IPv4 primeiro, conferindo o certificado pelo nome; `EnderecosTest` |

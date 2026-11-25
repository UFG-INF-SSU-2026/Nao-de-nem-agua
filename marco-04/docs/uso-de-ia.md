# Declaração de uso de IA

Este documento responde ao que o PDF pede: ferramenta, finalidade, síntese das
orientações, sugestões aproveitadas ou modificadas e forma de validação.

**Integrantes:** Davi Duarte Neco e Matheus Vieira Mendes Pacheco.

As ferramentas de IA foram usadas de duas formas: para **orientar** (analisar o
enunciado, sugerir caminhos, explicar tecnologias novas para o grupo) e para
**implementar** partes do código, dos testes e da documentação. A implementação
foi conduzida em conjunto: os integrantes definiram o que cada parte devia
fazer e em que ordem, acompanharam a escrita do código, testaram cada versão no
celular, apontaram os erros e pediram as correções até o comportamento ficar
como queriam, além de revisarem tudo o que a IA produziu. As
decisões de projeto ficaram com os integrantes; em algumas delas a IA
apresentou alternativas e recomendações, e o grupo escolheu o caminho. O grupo responde por compreender, testar e explicar todo o
material entregue.

## 1. Ferramentas

| Ferramenta | Quem usou | Como foi usada |
|---|---|---|
| **Claude Code** (Anthropic, modelo Claude Opus 5.5), no aplicativo desktop, com acesso ao repositório, ao terminal e ao celular pelo `adb` | Matheus | análise do enunciado e do repositório, plano das fases, implementação de partes do app e do backend, execução dos testes e rascunhos da documentação |
| **Codex** (OpenAI) | Davi | implementação de partes dos alertas e do notificador, apoio nos testes e revisão de código e de texto |

- **Período:** novembro de 2026, durante o desenvolvimento e o fechamento do
  Marco 4.

## 2. Finalidade e divisão do trabalho

| Etapa | O que a IA fez | O que os integrantes fizeram |
|---|---|---|
| Planejamento | analisou o PDF e o repositório, listou o que faltava e propôs um plano em 6 fases (backend do app, app, telas, sensor, histórico, fechamento) | conferiram a lista com o PDF, escolheram começar pelo app e decidiram quando avançar de fase |
| Ambiente | conferiu as versões do Android Studio e do Gradle (AGP 9.5.2, Gradle 9.6.0) e o aparelho pelo `adb` | instalaram o ambiente, conectaram o celular e liberaram a depuração |
| Backend para o app | implementou a identidade e o papel `app` na ACL, os contratos `EstadoVaso`, `SolicitacaoApp` e `RespostaApp`, o tratamento no serviço e a seção 19 do teste de integração | revisaram o código e as regras da ACL e validaram com o app conectado |
| App Android | implementou o projeto Kotlin/Compose: conexão MQTT/TLS com a CA do grupo, login, painel, alertas e reconhecimento de falha, com testes unitários | o Matheus especificou as telas e o fluxo (login, painel, alertas, reconhecimento de falha), testou cada versão no celular e conduziu as correções de comportamento e de interface até a versão final |
| Alertas e notificações (Codex) | implementou partes das regras de alerta e do notificador e sugeriu testes para cada regra | o Davi definiu as regras, revisou e ajustou o código e os testes |
| Sensor de luz | propôs a luz como regra **só de alerta** (R5) e implementou o contrato `LeituraLuz`, a regra no serviço, a persistência e a publicação pelo app | aprovaram a proposta, fizeram o ensaio com o sensor do celular e calibraram o comportamento |
| Histórico | implementou a API HTTPS somente leitura (`leitor_app`), a aba Histórico com gráficos e a suíte `teste:api` | revisaram a API e conferiram no celular os dados de sessões anteriores |
| Fechamento | gerou o APK de release e escreveu rascunhos da documentação, da matriz de testes e dos roteiros | revisaram, corrigiram e completaram os documentos, dividiram a apresentação e gravaram o vídeo |

## 3. Decisões e sugestões

**Decisões tomadas pelo grupo:** começar pelo app, a ordem das fases, quando
avançar, o escopo da entrega e a divisão da apresentação.

**Decisões de arquitetura tomadas pelo grupo** (em algumas delas a IA
apresentou as alternativas e uma recomendação, e o grupo decidiu):

- Kotlin + Jetpack Compose para o app.
- O app como **cliente MQTT** do broker existente, em vez de um backend novo.
- O app **não comanda atuador**: ele pede e o serviço decide.
- A luz como regra **só de alerta**, já que não há atuador de luz.
- API de histórico somente leitura com o papel `leitor_app`, que já existia.
- Assinar o APK com a chave de depuração, por ser uma entrega acadêmica.

**Modificadas depois dos testes no aparelho:**

- O campo `falhasPendentes`: o primeiro desenho confundia bloqueio e falha; o
  erro apareceu no celular e foi corrigido.
- O formato do horário, para aceitar os microssegundos enviados pelo Android.
- O diagnóstico de falha de rede, que vinha do `adb reverse`.

## 4. Validação

- Todo código, gerado pela IA ou pelos integrantes, foi **executado**: 129
  testes de integração, 48 unitários do backend, 37 de persistência, 25 da API
  e 30 do app, todos aprovados — ver [`testes.md`](testes.md) e
  [`evidencias/`](evidencias/).
- Verificação manual **no celular real** a cada fase, com capturas de tela e
  logs ([`aplicativo.md`](aplicativo.md), §6 a §8.1).
- **Revisão:** o Matheus revisou o que o Claude Code produziu (app, backend do
  app, sensor, API e persistência); o Davi revisou o que o Codex produziu
  (alertas e notificador) e a suíte de testes.
- **Estudo para a apresentação:** cada integrante estudou as partes que
  explicou no vídeo.

## 5. O que a IA não fez

- Não acessou segredos fora do fluxo do projeto nem os enviou para fora da
  máquina; a credencial de teste foi digitada no app pelo `adb`, sem aparecer
  na conversa.

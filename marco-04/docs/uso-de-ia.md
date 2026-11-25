# Declaração de uso de IA

> **Rascunho a revisar pelo grupo.** O PDF pede: ferramenta, finalidade, síntese
> das orientações, sugestões aproveitadas ou modificadas e forma de validação.
> O texto abaixo descreve o uso feito na parte do aplicativo e do fechamento do
> Marco 4; completem com os demais usos do grupo (outros marcos, artigo, etc.) e
> confirmem cada afirmação. O grupo responde por compreender, testar e explicar
> o material entregue.

## Ferramenta

- **Claude Code** (Anthropic), modelo Claude Opus 5.5, no aplicativo desktop,
  com acesso ao repositório, ao terminal e ao celular pelo `adb`.
- Período: [A PREENCHER: datas].
- Integrante(s) que conduziram: [A PREENCHER].

## Finalidade e síntese

| Etapa | O que foi pedido à IA | O que ela produziu |
|---|---|---|
| Planejamento | analisar o PDF do Marco 4 e o repositório; dizer o que faltava e planejar o app | lista do que faltava e plano em 6 fases (backend do app, app, telas, sensor, histórico, fechamento) |
| Ambiente | verificar Android Studio, SDK e celular | conferência das versões (AGP 9.5.2, Gradle 9.6.0) e do aparelho (`adb`) |
| Backend para o app | identidade e papel `app` na ACL; contratos `EstadoVaso`, `SolicitacaoApp`, `RespostaApp`; tratamento no serviço; certificado para Wi-Fi | código, contratos e a seção 19 do teste de integração |
| App Android | projeto Kotlin/Compose: conexão MQTT/TLS com a CA do grupo, login, painel, alertas, reconhecimento de falha | código do app e testes unitários |
| Sensor de luz | contrato `LeituraLuz`, regra R5 no serviço, persistência, publicação pelo app | código, testes (unitários e seção 20) |
| Histórico | API HTTPS somente leitura (`leitor_app`), aba Histórico com gráficos | API, testes (`teste:api`), tela |
| Fechamento | APK de release, documentação de implantação, matriz de testes, roteiros e rascunhos | estes documentos |

## Decisões tomadas pelo grupo × sugestões da IA

- O grupo escolheu **começar pelo app**, a ordem das fases e quando avançar.
- **Aproveitadas**: Kotlin + Compose; o app como cliente MQTT (e não um
  backend novo); o app **não comanda atuador** (pede, o serviço decide); a luz
  como regra **só de alerta** (não há atuador de luz); API somente leitura com o
  papel `leitor_app` que já existia; assinar o APK com a chave de depuração.
- **Modificadas a partir dos testes no aparelho**: o campo `falhasPendentes`
  (o primeiro desenho confundia bloqueio e falha), o formato do horário
  (microssegundos do Android) e o diagnóstico de falha de rede pelo `adb reverse`.
- [A PREENCHER: sugestões que o grupo rejeitou ou alterou, se houver]

## Validação

- Todo código gerado foi **executado**: suítes automatizadas (126 de
  integração, 40 unitários, 37 de persistência, 25 da API, 23 do app) —
  [`testes.md`](testes.md) e [`evidencias/`](evidencias/).
- Verificação manual **no celular real** a cada fase, com capturas de tela e
  logs ([`aplicativo.md`](aplicativo.md), §6 a §8.1).
- [A PREENCHER: revisão de código feita pelo grupo — quem revisou o quê]
- [A PREENCHER: o que cada integrante estudou para conseguir explicar na apresentação]

## O que a IA não fez

- Não acessou os segredos fora do fluxo do projeto nem os enviou para fora da
  máquina; a credencial de teste foi digitada no app pelo `adb`, sem aparecer
  na conversa.
- Não escreveu o artigo [A CONFIRMAR] nem gravou o vídeo.
- Não fez commits nem publicou nada.

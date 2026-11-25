# Limitações declaradas — visão consolidada

O PDF do Marco 4 pede, nos requisitos mantidos, que se declarem **simulações,
uso de dados pessoais e limitações de segurança, conectividade, desempenho e
energia**, e que pendências venham **com seu impacto e justificativa**. Este
documento reúne essas declarações num lugar só. Os detalhes continuam nos
documentos de cada parte, indicados em cada item.

Resumo:

| Categoria | Principal limitação | Impacto |
|---|---|---|
| Simulações | nenhuma grandeza do vaso é medida de verdade; a única medição real é a luz do celular | as regras foram verificadas com valores controlados, não com uma planta |
| Dados pessoais | a luz e o histórico descrevem o ambiente da casa; a senha lembrada não usa o Android Keystore | baixo: não há nome, localização nem contatos |
| Segurança | chaves HMAC do dispositivo e do app extraíveis; broker público sem senha nem ACL | quem extrair uma chave se passa por **aquele** dispositivo ou app, não pelo serviço |
| Conectividade | app só conectado com a tela aberta; caminho B depende de internet e de broker de terceiros | sem notificação com o app fechado; alertas daquele período só no histórico |
| Desempenho | um vaso por processo; fila de gravação limitada; snapshot a cada 2 s | escala de bancada; um `SIGKILL` com o banco fora perde a fila |
| Energia | consumo do ESP32 não medido; luz só com o app na tela | a luz é medição pontual, não monitoramento contínuo |

---

## 1. Simulações

- **Sensores do vaso.** A sonda de solo 3-em-1 (umidade, temperatura e EC) é um
  *custom chip* escrito pelo grupo para o Wokwi, que converte sliders em
  tensões com um modelo físico declarado. O DHT22 e os dois HC-SR04 são
  componentes do Wokwi controlados por slider. No caminho A, o simulador em
  Node.js gera os valores pelo teclado, com uma física simples declarada.
  → [`marco-04.md`, §1 e §8](marco-04.md#8-limitações-declaradas)
- **Atuadores.** Bomba de água, bomba de fertilizante e umidificador são relés
  (LEDs no Wokwi). Não há água: o efeito que a R2 e a R3 verificam também vem
  de sensores simulados.
- **Única medição real:** a iluminância do sensor do celular (Galaxy A16,
  TCS3701). → [`aplicativo.md`, §7](aplicativo.md#7-sensor-de-luz-o-app-como-produtor-r5)
- **Firmware não compilado localmente** (sem toolchain do ESP32 nesta máquina):
  o formato das mensagens foi conferido contra os schemas; a compilação
  acontece no Wokwi.
- **Tempos de demonstração.** Tempo mínimo da luz (15 s), janela de doses de
  adubo (60 s) e bloqueio por falha (2 min) são curtos para caber no vídeo; em
  uso real seriam horas ou dias. Todos estão em [`config.json`](../config.json).

**Justificativa:** o projeto é de bancada e sem hardware físico; a escolha foi
declarar cada substituto em vez de apresentá-lo como medição.

## 2. Uso de dados pessoais

- **O que o sistema não coleta:** nome, e-mail, localização, contatos ou fotos
  da pessoa. O app pede **apenas a permissão de internet**
  (`AndroidManifest.xml`).
- **O que pode ser considerado dado pessoal:**
  - a **identidade** `app-vaso-01` e sua senha. A identidade é por vaso, não
    por pessoa;
  - a **senha lembrada**, guardada só se o usuário marcar "lembrar", no
    armazenamento privado do app (DataStore). É protegida pelo sandbox e pela
    criptografia de arquivos do Android, mas **não** pelo Android Keystore. O
    backup do app está desligado (`allowBackup=false`);
  - as **leituras de luz** e o **histórico** de solo e ar, que descrevem a
    rotina e o ambiente da casa (por exemplo, quando a sala fica escura).
- **Onde ficam:** no TimescaleDB, que escuta só em `127.0.0.1`. O app lê pela
  API somente leitura. A telemetria bruta é **apagada após 30 dias**
  (`persistencia.retencaoDias`).
- **Broker público (caminho B):** o HiveMQ entrega o conteúdo das mensagens a
  qualquer assinante do tópico. Nenhuma senha é enviada a ele.

→ [`aplicativo.md`, §9](aplicativo.md#9-limitações-declaradas) ·
[`persistencia.md`](persistencia.md)

## 3. Segurança

- **Chaves HMAC versionadas.** As chaves dos dispositivos estão no repositório
  (`seguranca/chaves-hmac.json` e `sketch.ino`) porque o sketch do Wokwi precisa
  delas. Em produção seriam provisionadas por dispositivo, com *flash
  encryption* do ESP32.
- **Chave do app dentro do APK.** Pode ser extraída do APK. Quem a extrair se
  passa pelo app daquele vaso (pedidos e luz), mas não pelo ESP32 nem pelo
  serviço; a chave privada do serviço não vai para o APK.
- **Broker público sem senha nem ACL.** Ali, a autenticidade depende só das
  assinaturas (HMAC e ECDSA), e a confidencialidade vale só até o broker.
- **TLS por trecho, não de ponta a ponta na mensagem.** Cada ligação usa TLS
  (dispositivo, serviço e app até o broker; app até a API), mas o broker vê o
  conteúdo. A ligação serviço → banco não usa TLS, aceitável só porque o banco
  escuta em `127.0.0.1`.
- **Sem rotação nem revogação individual** de credenciais. A API usa HTTP Basic,
  sem token de curta duração; o limite de tentativas fica em memória.
- **Notificador de terminal não confere** a assinatura dos alertas (o app
  confere).
- **APK assinado com a chave de depuração:** não serve para loja e não prova
  autoria.
- **Chave privada da CA no disco** da bancada, sem HSM.

→ [`seguranca.md`, §5](seguranca.md#5-limitações-declaradas) ·
[`implantacao.md`, §8](implantacao.md#8-limitações-da-implantação)

## 4. Conectividade

- **Caminho B** depende de internet e de um broker de terceiros
  (`broker.hivemq.com`). Nesse modo, o app não tem a aba Histórico.
- **App só conectado com a tela aberta.** Não há serviço em segundo plano nem
  notificação push com o app fechado. Os alertas não são retidos: quem não
  estava conectado perde os avisos daquele período, que continuam disponíveis
  no histórico do banco.
- **Luz sem conexão é descartada** (não se enfileira luz velha).
- **Buffer offline do dispositivo só guarda o solo** (24 leituras, sem os
  campos de EC). Ar e nível são estado corrente.
- **APK ligado à máquina:** o APK embute a CA da máquina em que foi compilado e
  só conversa com o broker e a API dessa máquina. Em outra máquina é preciso
  recompilar ([`implantacao.md`, §5.1](implantacao.md#51-instalar)).
- **Relógios.** O dispositivo não tem NTP (`eventTimeMs` é relativo ao boot). O
  TTL dos alertas e o prazo dos pedidos do app dependem de relógios
  sincronizados entre serviço, notificador e celular (tolerância de 30 s).

**Justificativa:** o risco principal do projeto é justamente a conectividade;
por isso a regra que impede o perigoso fica no dispositivo e funciona sem rede
([`marco-04.md`, §2 e §4](marco-04.md#4-proteções-físicas-no-dispositivo)).

## 5. Desempenho e escala

- **Um vaso por processo do serviço.** O cadastro e as tabelas já são por
  `vaso_id`, mas o serviço atende o `vaso-01` do `config.json`.
- **Fila de gravação em memória**, limitada a 10 000 linhas (cerca de 1 h de
  telemetria a 3 eventos/s). Se o serviço morrer com o banco fora, a fila se
  perde.
- **Snapshot do estado a cada 2 s (no mínimo):** um `SIGKILL` pode perder a
  última mudança, exceto o que a política de "dose em curso conta" cobre.
- **Deduplicação limitada aos últimos 500 `eventId`.**
- **Tudo numa máquina** (broker, serviço, banco e API). Não houve teste de
  carga; os números do projeto são de bancada.
- A suíte de integração leva cerca de 4 minutos porque espera prazos reais; numa
  máquina carregada, uma verificação de deduplicação já falhou por tempo uma vez
  (repetida sem carga, passou — [`testes.md`, §5](testes.md#5-bugs-que-os-testes-encontraram)).

→ [`persistencia.md`, §7](persistencia.md#7-limitações)

## 6. Energia

- **Consumo do ESP32 não foi medido.** O firmware mantém o Wi-Fi ligado o tempo
  todo e publica solo, nível e heartbeat a cada 1,5 s e o ar a cada 2 s, sem
  *deep sleep*. Em
  bateria, isso não seria viável; o projeto supõe o dispositivo na tomada.
- **Celular:** o sensor de luz só é lido com o app na tela, justamente para não
  gastar bateria. Por isso a luz é uma **medição pontual** para escolher o
  lugar do vaso, não monitoramento contínuo.
- **Atuadores:** dose de adubo e concessão do umidificador têm teto (10 s e
  120 s) no próprio dispositivo, o que também limita o tempo ligado.

## 7. Outras pendências

| Pendência | Impacto | Justificativa |
|---|---|---|
| Limiares de luz fixos (jiboia), fora do perfil por espécie do banco | outra espécie recebe avisos de luz calibrados para jiboia | o perfil por espécie entrou para solo, ar e adubo; a luz ficou para a evolução |
| Leitura em lux varia entre aparelhos | limiares podem precisar de ajuste por celular | calibração de fábrica de cada sensor |
| Alexa e tomadas inteligentes (Atividade 01) não implementadas | o aviso chega só pelo app e pelo notificador | escopo dos marcos; o app ocupou o papel de interface |
| Fotos das plantas: só a tabela de metadados | sem upload de fotos | fora do escopo do Marco 4 |

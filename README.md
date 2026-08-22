# Nao de nem agua

**Disciplina:** Software para Sistemas Ubíquos - UFG  
**Integrantes:** 
- Matheus Vieira Mendes Pacheco
- Davi Duarte Neco
- Bárbara Nogueira

---

## Parte 1 - Compreensão do problema

**1. Problema e usuários.** 
O sistema visa resolver a dificuldade de manter o microclima, a iluminação e a irrigação ideais para plantas em ambiente doméstico, prevenindo a perda de espécimes por estresse hídrico (falta ou excesso de água) ou iluminação inadequada (estiolamento ou queima de folhas). Os usuários são cultivadores de plantas de interior que possuem rotinas ocupadas e necessitam de assistência inteligente para monitoramento e manutenção de suas plantas.

**2. Contexto.** 
Para que a solução funcione adequadamente, o sistema precisa perceber:
- **Ambiente:** Umidade do solo de cada vaso, temperatura ambiente, umidade relativa do ar e nível de luminosidade/incidência solar (em lux ou escala relativa).
- **Usuário/Sistema:** Espécie vegetal associada a cada vaso/sensor (ex.: diferenciar espécies que demandam alta luminosidade e pouca água, de plantas que preferem meia-sombra e alta umidade no ar).

**3. Dispositivos e comunicação.** 
Participam do sistema:
- **Dispositivos de Borda/Sensores:** Sensores de umidade do solo, sensores de temperatura/umidade do ar (DHT) e sensores de luminosidade (LDR / BH1750).
- **Gateway Local:** Microcontrolador com conectividade Wi-Fi (ex.: ESP32).
- **Atuadores e Interfaces:** Tomadas inteligentes conectadas à rede Wi-Fi, assistente virtual (Amazon Echo / Alexa) e aplicação Web/Mobile.
- **Comunicação:** O microcontrolador envia os dados dos sensores ao servidor em nuvem via Wi-Fi (utilizando protocolos MQTT ou HTTP/REST). O servidor em nuvem integra-se aos ecossistemas da Alexa e das tomadas inteligentes através de APIs REST e Webhooks.

**4. Processamento e resposta.** 
O processamento ocorre remotamente em um backend. O sistema processa os fluxos de telemetria, cruza os valores com a matriz de requisitos da espécie da planta e gera:
- **Atuações automáticas:** Acionamento de tomadas inteligentes para ligar a mini-bomba d'água (irrigação) ou o umidificador de ar.
- **Recomendações e Alertas:** Notificações proativas via aplicativo e avisos por voz pela Alexa sugerindo ações contextuais (ex.: *"A luminosidade está baixa para o calanchoê há 3 dias. Recomenda-se aproximar o vaso da janela."*).

**5. Risco principal.** 
**Dependência de conectividade e latência externa.** Como o sistema adota processamento remoto e orquestração de APIs de terceiros (nuvem da Alexa e fabricantes de tomadas inteligentes), qualquer perda de conexão com a internet ou indisponibilidade de serviços externos inviabiliza as atuações automáticas e as notificações, criando o risco de falha na irrigação mesmo com o solo seco.

---

## Parte 2 - Modelagem do sistema

**6. Sensores, atuadores e gateway.** 
- **Sensores:**
  - *Higrômetro capacitivo de solo:* Mede o teor de umidade da terra.
  - *Sensor de temperatura e umidade do ar (DHT):* Monitora as condições climáticas locais.
  - *Sensor de luminosidade (LDR / BH1750):* Monitora a exposição à luz no ponto do vaso.
- **Atuadores:**
  - *Tomadas inteligentes:* Controlam a alimentação elétrica da mini-bomba de água e do umidificador.
  - *Amazon Echo / Alexa:* Interface conversacional e emissão de alertas sonoros.
- **Gateway:**
  - *Microcontrolador (ESP32):* Faz a leitura analógica/digital dos sensores, consolida as medições e encaminha os pacotes de dados pela rede Wi-Fi.

**7. Fluxo do sistema.** 
`Fenômeno físico (Baixa umidade do solo / Alta luminosidade e calor)` -> `Sensores (Higrômetro, DHT e sensor de luz)` -> `Gateway (ESP32 via Wi-Fi)` -> `Processamento (Backend em nuvem cruza dados e calcula evapotranspiração)` -> `Decisão (Necessidade imediata de irrigação e alerta de ambiente)` -> `Resposta/Atuadores (API aciona tomada da bomba de irrigação + Alexa emite aviso por voz)`.

**8. Classificação.** 
O sistema pode ser classificado como:
- **Internet das Coisas (IoT):** Pela integração em rede de sensores, atuadores comerciais e serviços em nuvem.
- **Sistema Ciber-Físico (CPS):** Pela existência de um ciclo fechado de controle (*feedback loop*) onde a análise computacional age fisicamente sobre o ambiente (bomba de água e umidificador).
- **Aplicação Ubíqua:** Pela sensibilidade ao contexto ambiental e atuação pervasiva e transparente no cotidiano do usuário por meio de voz e automações.

**9. Contexto e adaptação.** 
O sistema adapta seu comportamento diante de duas principais mudanças de contexto:
- **Correlação Climática e Luminosidade:** Se o sistema detecta simultaneamente alta luminosidade e temperatura elevada, deduz um aumento na taxa de evaporação do substrato e antecipa ou ajusta a dosagem de irrigação.
- **Alteração do Tipo de Planta:** Ao alterar o cadastro da planta de um vaso no aplicativo, o sistema recalcula dinamicamente os parâmetros ideais de umidade e luz aceitáveis, adaptando todos os gatilhos de irrigação e alertas de luminosidade.

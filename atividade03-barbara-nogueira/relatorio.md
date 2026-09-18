# Atividade 03 — Estado temporal e resiliência

## 1. Identificação

Estudante: Bárbara Nogueira. Matrícula: 202004744.
Projeto do grupo: Não dê nem água.
Responsabilidade: estado temporal e resiliência, com expiração de leituras, bloqueio da autorização e recuperação.
Execução realizada no Wokwi pelo navegador em 17/09/2026. Os resultados foram documentados por capturas do circuito e do monitor serial. Os tempos apresentados são relativos ao início da simulação.

## 2. Relação com as Atividades 01 e 02

O projeto monitora e irriga plantas domésticas. A Atividade 01 identificou sensores, usuários e dependência de conectividade. A Atividade 02 estabeleceu a necessidade de dados atuais para autorizar atuação. Este protótipo isola a validade temporal da umidade do solo.

O ESP32 mantém estado e executa a regra localmente para permitir sua observação no Wokwi. Nesse recorte, exerce funções de dispositivo e processamento de borda. Não é implementada comunicação de rede. A decisão local não modifica a arquitetura completa registrada na Atividade 02, cuja decisão está na nuvem.

## 3. Fenômeno, entrada, unidade e faixa

Um potenciômetro representa um índice fictício de umidade de solo entre 0 e 100%. A leitura ADC de 12 bits, entre 0 e 4095, é convertida por valor × 100 / 4095. Não há aquisição, calibração ou validação de umidade física real.

Uma chave representa a interrupção da produção de leituras: esquerda permite amostrar; direita pausa. A pausa não apaga o último valor. A chave não representa a desconexão elétrica real de um sensor. Sua simulação de bounce foi desabilitada para isolar o teste temporal.

Valores não finitos ou fora de [0,100] são inválidos. Digitar i no monitor serial injeta -1 como leitura inválida. Isso testa a lógica de qualidade, sem simular uma falha elétrica específica.

## 4. Circuito e componentes

ESP32 DevKit v1, um potenciômetro, uma chave deslizante, um LED verde, um LED vermelho e dois resistores de 220 ohms.

Potenciômetro: VCC em 3V3, GND em GND e SIG em GPIO34.
Chave: terminal comum 2 em GPIO23, terminal 1 em GND e terminal 3 desconectado. GPIO23 usa INPUT_PULLUP.
LED verde: GPIO18 → resistor → anodo; catodo em GND.
LED vermelho: GPIO19 → resistor → anodo; catodo em GND.

O LED verde representa autorização lógica de irrigação. Não é uma bomba nem indica água aplicada. O vermelho indica estado desconhecido, obsoleto ou inválido. Em NORMAL e AGUARDANDO, ambos ficam apagados; o estado detalhado aparece no monitor serial.

## 5. Contrato do evento

O programa produz JSON no monitor serial a 115200 baud. Tipos: umidade.leitura, estado.inicial, estado.alterado, dispositivo.status e leitura.invalida.

Campos: eventType (tipo), deviceId (esp32-barbara-01), entityId (vaso-01), eventTimeMs (ocorrência em ms desde o início), sequence (contador crescente por execução), value (último valor válido ou null), unit (pct_simulado), state, valid, actuatorAuthorized e ageMs (idade da última amostra válida ou null). leitura.invalida inclui rejectedValue=-1.

Exemplo de leitura: {"eventType":"umidade.leitura","deviceId":"esp32-barbara-01","entityId":"vaso-01","eventTimeMs":3000,"sequence":8,"value":20.00,"unit":"pct_simulado","state":"AGUARDANDO","valid":true,"actuatorAuthorized":false,"ageMs":0}.

millis() não representa UTC. eventTimeMs e sequence reiniciam em cada execução; não servem para ordenar execuções diferentes sem identidade adicional. Nos eventos de estado e status, eventTimeMs é o instante do status/transição, enquanto ageMs informa a idade da medição retida. value retido não implica dado válido: valid=false em estados de falha.

## 6. Estado, regra e atuação

Estados: DESCONHECIDO, NORMAL, AGUARDANDO, AUTORIZADO, DADO_OBSOLETO e LEITURA_INVALIDA.

Amostragem a cada 1000 ms. Solo fictício seco: valor < 30%. Igual a 30% é NORMAL. Três amostras secas válidas consecutivas autorizam a saída; com a amostragem regular, isso requer aproximadamente dois segundos entre a primeira e a terceira. Uma amostra não seca interrompe a contagem.

A leitura vence quando idade >= 5000 ms. O loop verifica a idade continuamente, mesmo sem novas amostras. Ao vencer, preserva o último valor, zera a contagem, entra em DADO_OBSOLETO, desliga o verde e liga o vermelho. A ausência inicial mantém DESCONHECIDO.

Entrada inválida bloqueia imediatamente a autorização. A recuperação, tanto de inválido quanto de obsoleto, exige novas leituras: uma leitura não seca retorna a NORMAL; três secas consecutivas retornam a AUTORIZADO. A autorização não é um pulso de bomba; mantém-se enquanto as condições forem válidas. Esse protótipo não implementa controle de volume, cooldown ou histerese da bomba, que pertencem ao recorte de decisão e atuação.

As saídas são escritas de forma idempotente; não há comandos de bomba repetidos. O contador de amostras evita autorização por um pico seco isolado. Os tempos reduzidos facilitam observar o comportamento e não equivalem aos parâmetros de cultivo da Atividade 02.

## 7. Testes e resultados no Wokwi

Os testes foram realizados com manipulação do potenciômetro e da chave durante a execução pelo navegador. As capturas registram instantes selecionados, não um log completo da sessão. Os resultados observados abaixo se limitam aos valores, estados e saídas visíveis. Tempos de simulação não correspondem necessariamente ao tempo decorrido no relógio do computador.

### 7.1 Estado normal

Estado inicial: coleta habilitada, entrada fictícia próxima de 60% e autorização desligada.

Sequência aplicada: manter o potenciômetro acima do limiar de 30% e permitir novas leituras pela chave à esquerda.

Resultado esperado: NORMAL, valid=true, actuatorAuthorized=false e LEDs de autorização e falha apagados.

Resultado observado: a captura de 17h28min26s mostra leituras de 60,71% em eventTimeMs=950697, sequence=1837; 951697, sequence=1839; 952697, sequence=1841; e 953697, sequence=1843. Todas apresentam NORMAL, valid=true, actuatorAuthorized=false e ageMs=0. Os dois LEDs de indicação estão apagados. A luz de alimentação da placa não representa falha.

Explicação: a informação está atual, mas a umidade fictícia acima de 30% não satisfaz a condição de solo seco.

Evidência: evidencias/teste-normal.png. Resultado compatível com o esperado.

### 7.2 Decisão e resposta observável

Estado inicial: NORMAL, com valor de 37,05% no status de eventTimeMs=999000, sequence=1934.

Sequência aplicada: reduzir o valor do potenciômetro, mantendo a coleta. As três leituras secas consecutivas registradas são:

1. eventTimeMs=999697, sequence=1935, value=27.37: AGUARDANDO, autorização false.
2. eventTimeMs=1000697, sequence=1938, value=25.91: AGUARDANDO, autorização false.
3. eventTimeMs=1001697, sequence=1940, value=25.23: AUTORIZADO, autorização true.

Resultado esperado: duas amostras em AGUARDANDO, seguidas de AUTORIZADO na terceira; verde aceso e vermelho apagado.

Resultado observado: a captura de 17h31min37s mostra a sequência completa, todas as leituras válidas e com ageMs=0. Em 1001697 ms, o log registra state=AUTORIZADO e authorization=ON, e o verde está aceso. A captura de 17h32min02s mostra a manutenção de AUTORIZADO, inclusive com uma nova leitura de 21,90% em 1002697 ms, sequence=1943.

Explicação: os três valores estão abaixo de 30%. Há 1000 ms entre amostras e 2000 ms entre a primeira e a terceira. O programa confirma a condição antes de autorizar a resposta por LED. Não há bombeamento real.

Evidências: evidencias/teste-decisao.png e evidencias/decisao-autorizada.png. Resultado compatível com o esperado.

### 7.3 Teste adversarial individual — matrícula final 4

Situação obrigatória: informação que continua armazenada depois de perder a validade.

Estado inicial: AUTORIZADO com valor retido de 21,90% e leitura ainda válida.

Sequência aplicada: interromper novas amostras pela chave, manter o valor do potenciômetro e acompanhar ageMs até a expiração.

Resultado esperado: preservar o último valor na memória, mas retirar a autorização quando sua idade atingir 5000 ms, com DADO_OBSOLETO e LED vermelho aceso.

Resultado observado: a captura de 17h34min28s registra AUTORIZADO em 1149000 ms, sequence=2235, ageMs=1303; 1150000 ms, sequence=2236, ageMs=2303; 1151000 ms, sequence=2237, ageMs=3303; e 1152000 ms, sequence=2238, ageMs=4303. Em todos esses status, value=21.90, valid=true e actuatorAuthorized=true.

Em eventTimeMs=1152697, sequence=2239, o evento estado.alterado mostra DADO_OBSOLETO, value=21.90, valid=false, actuatorAuthorized=false e ageMs=5000. O log indica reason=validade_expirada e authorization=OFF. A captura de 17h34min37s confirma o verde apagado, o vermelho aceso e a manutenção do bloqueio em status posteriores, com idades de 5303 até 11303 ms.

O instante da última leitura válida é deduzido pelo par tempo/idade: 1152697 − 5000 = 1147697 ms. O cálculo é consistente com os status anteriores. Esse instante é uma inferência a partir dos campos visíveis, não uma leitura transcrita das capturas.

Explicação: uma implementação ingênua continuaria usando 21,90% como informação presente mesmo com a coleta interrompida. O protótipo verifica o tempo independentemente de novas amostras, preserva o valor para diagnóstico e bloqueia a autorização ao vencer sua validade.

Evidências: evidencias/adversarial-antes-expiracao.png e evidencias/teste-adversarial.png. A primeira captura contém tanto os status anteriores quanto a transição; seu circuito já mostra o estado obsoleto atual. Resultado compatível com o esperado.

### 7.4 Recuperação após obsolescência

Estado inicial: DADO_OBSOLETO com valor de 21,90% retido; o status em 1187000 ms, sequence=2274, mostra ageMs=39303 e autorização false.

Sequência aplicada: reabilitar a coleta mantendo o potenciômetro na posição de 21,90%.

Resultado esperado: reiniciar a contagem e autorizar somente após três novas amostras secas válidas.

Resultado observado: as capturas de 17h35min42s e 17h35min55s mostram:

1. eventTimeMs=1187998, sequence=2275: value=21.90, AGUARDANDO, valid=true, autorização false e ageMs=0.
2. eventTimeMs=1188998, sequence=2278: value=21.90, AGUARDANDO, valid=true, autorização false e ageMs=0.
3. eventTimeMs=1189998, sequence=2280: value=21.90, AUTORIZADO, valid=true, autorização true e ageMs=0.

O log em 1189998 ms confirma authorization=ON. O LED verde está aceso e o vermelho apagado. A sequência comprova que a contagem anterior não é reaproveitada depois da expiração: são necessárias três novas amostras em intervalos de 1000 ms.

As mensagens mostradas no monitor foram preservadas enquanto a execução avançava. Portanto, o circuito exibe o estado atual, e a evolução anterior deve ser interpretada pelos instantes dos eventos. A captura de 17h35min55s registra integralmente a sequência até a reautorização.

Evidências: evidencias/teste-recuperacao.png e evidencias/recuperacao-autorizada.png. Resultado compatível com o esperado.

### 7.5 Qualidade e limites da evidência

O comando i injeta uma leitura inválida, e seu bloqueio é coberto pelos testes locais. Não há captura desse cenário no Wokwi entre as evidências apresentadas; ele não é declarado como teste executado no simulador. O adversarial obrigatório deste estudante é o de expiração, documentado acima.

## 8. Verificação local realizada

A lógica real de controle foi compilada com g++ e testada por asserções. Foram verificados NORMAL, três amostras secas, idade 4999 ms, expiração exatamente em 5000 ms, retenção de valor antigo, recuperação, valores inválidos, NaN, igualdade ao limiar e passagem do contador de tempo por rollover.

O sketch completo também foi compilado e executado em um harness C++ com interfaces Arduino substituídas. Foram verificadas as saídas digitais e analisados os eventos JSON. Logs estão em evidencias/verificacao-local-controle.txt e evidencias/verificacao-local-firmware.txt. Isso comprova a lógica nos cenários locais, mas não comprova compilação para ESP32, conexões do circuito ou execução Wokwi.

## 9. Limitações

Não são validados umidade física, precisão, calibração, ruído real, instalação, dinâmica de secagem, fluxo de água, segurança elétrica, consumo ou autonomia. Não há nuvem, tomada comercial, Alexa ou aplicativo implementados. O LED indica uma decisão lógica, sem realimentação física. A expiração depende de o processador continuar executando; um travamento real exigiria outras medidas. O estado em RAM reinicia como desconhecido após reboot.

## 10. Uso de IA generativa

Ferramenta: OpenAI/Codex. Uso: proposta de divisão dos recortes, estrutura do circuito, elaboração do código, testes locais e redação do relatório a partir das evidências de simulação.

Síntese das orientações: desenvolver um protótipo de plantas domésticas relacionado às atividades anteriores, especializado em expiração de dados e no adversarial de matrícula final 4.

Sugestões adotadas: entrada substituta declarada, chave para interromper amostras, estados explícitos, temporização não bloqueante e eventos estruturados. Adaptação: a saída foi definida como autorização lógica, com regra local restrita ao recorte da simulação.

Erro identificado e corrigido: a primeira versão do circuito utilizava nomes numéricos para quatro terminais da placa, omitindo o prefixo D exigido pelo componente ESP32 DevKit v1 no Wokwi. Foram corrigidos para D34, D23, D18 e D19. Os números de GPIO no programa permaneceram 34, 23, 18 e 19.

Limitação identificada: os testes locais não validam a execução Wokwi; resultados de simulação foram documentados separadamente com capturas reais. As capturas registram os cenários selecionados, incluindo as três amostras até a autorização, a expiração e as três amostras de recuperação; não constituem um log completo de toda a sessão. A estudante permanece responsável por compreender, revisar e explicar o material entregue.

## 11. Link compartilhável e conclusão

Link compartilhável: https://wokwi.com/projects/475420562350777345

As capturas documentam estado normal, autorização e expiração de dado armazenado, com saída visual e eventos estruturados. A recuperação também está registrada. A evidência adversarial demonstra retirada da autorização exatamente em ageMs=5000, preservando o valor antigo. O protótipo valida esse comportamento lógico no simulador, sem demonstrar irrigação física ou calibração de umidade real.

## Referências

Enunciado da Atividade 03 e materiais das aulas 1 a 4.
https://docs.wokwi.com/guides/esp32
https://docs.wokwi.com/diagram-format
https://docs.wokwi.com/parts/wokwi-potentiometer
https://docs.wokwi.com/parts/wokwi-slide-switch

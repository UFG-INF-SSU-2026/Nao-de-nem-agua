/*
 * gateway-vaso -- COMPONENTE PRODUTOR do Marco 2, caminho B (dispositivo real).
 *
 * Projeto do grupo: "Nao de nem agua" -- cuidado assistido de plantas de interior.
 * Disciplina: Software para Sistemas Ubiquos (UFG).
 *
 * O QUE ESTE FIRMWARE FAZ
 * -----------------------
 * Le a umidade do substrato, publica telemetria e heartbeat por MQTT, assina o
 * topico de comando e atua na bomba -- aplicando idempotencia e prazo de
 * validade antes de qualquer atuacao. Confirma cada comando com um evento de
 * confirmacao de negocio.
 *
 * O QUE MUDOU EM RELACAO AO MARCO 1
 * ---------------------------------
 * Nos prototipos individuais, o dispositivo lia, decidia e atuava sozinho. Aqui
 * a DECISAO saiu do dispositivo e foi para o servico, conforme a distribuicao
 * definida na Atividade 02 (itens 10 e 11): ao dispositivo couberam leitura,
 * validacao local, carimbo de tempo, enfileiramento offline e atuacao; a
 * janela de estado e a regra pertencem a nuvem.
 *
 * O que o dispositivo ganhou ao atravessar a fronteira:
 *   - bootId, que resolve a limitacao declarada no Marco 1 de que sequence e
 *     eventTimeMs reiniciam a cada execucao;
 *   - will message (LWT), que torna a queda abrupta observavel imediatamente;
 *   - buffer offline, para que a queda de rede nao apague as medicoes;
 *   - idempotencia e expiracao na recepcao de comando, porque agua aplicada
 *     duas vezes, ou aplicada tarde, e um efeito fisico indesejado.
 *
 * LIMITACOES DECLARADAS
 * ---------------------
 * 1. ENTRADA SUBSTITUTA: o Wokwi nao possui higrometro capacitivo de solo. Um
 *    POTENCIOMETRO representa, de forma ficticia, a umidade do substrato
 *    (0-100%). Nao ha aquisicao real da grandeza fisica.
 * 2. SEM NTP: eventTimeMs e millis() -- tempo desde o boot, nao instante
 *    absoluto. E por isso que o prazo de validade do comando chega expresso no
 *    relogio do proprio dispositivo (expiresAtDeviceMs).
 * 3. BROKER PUBLICO, SEM SENHA NEM ACL: o Wokwi nao alcanca o localhost da
 *    maquina de apresentacao, o que obriga o uso de um broker publico -- e
 *    nele qualquer pessoa pode publicar nos nossos topicos. A seguranca do
 *    Marco 3 neste caminho e:
 *      - CANAL: MQTT sobre TLS (porta 8883), conferindo o certificado do
 *        broker contra a CA raiz fixada abaixo. Ninguem no caminho le ou
 *        altera o trafego, e o ESP32 sabe que fala com broker.hivemq.com.
 *      - AUTENTICIDADE: toda mensagem sai assinada com HMAC-SHA256 da chave
 *        deste dispositivo, e todo comando so e executado se vier assinado
 *        pelo servico com essa mesma chave. Um comando forjado no broker
 *        publico recebe REJEITADO_ASSINATURA e a bomba nao liga.
 *    Usuario/senha e ACL existem apenas no broker local (caminho A).
 * 4. CHAVE NO FIRMWARE: a chave HMAC esta no codigo porque o Wokwi exige o
 *    sketch completo. Em producao ficaria na NVS com flash encryption.
 * 5. O LED representa a bomba. Nao ha bomba, agua nem realimentacao fisica.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "mbedtls/md.h"

// --------------------------------------------------------------------------
// Pinos
// --------------------------------------------------------------------------
const int PIN_UMIDADE     = 34;  // potenciometro: entrada substituta do solo
const int PIN_LED_BOMBA   = 26;  // atuacao: representa a bomba de irrigacao
const int PIN_LED_STATUS  = 25;  // aceso = conectado ao broker

// --------------------------------------------------------------------------
// Rede e broker
// --------------------------------------------------------------------------
const char* WIFI_SSID  = "Wokwi-GUEST";
const char* WIFI_SENHA = "";
const int   WIFI_CANAL = 6;      // acelera a associacao no simulador

const char* BROKER_HOST = "broker.hivemq.com";
const int   BROKER_PORTA = 8883;   // MQTT sobre TLS

/*
 * CA raiz que assina a cadeia do broker.hivemq.com (Amazon Root CA 1, valida
 * ate 2038). O ESP32 confere o certificado recebido contra ela e contra o nome
 * do host: e isso que impede um terceiro de se passar pelo broker. Nao se usa
 * setInsecure(), que cifraria o canal sem saber com quem.
 */
const char* CA_RAIZ_BROKER = R"PEM(
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----
)PEM";

// --------------------------------------------------------------------------
// Identidade e contrato
// --------------------------------------------------------------------------
const char* DEVICE_ID = "esp32-vaso-01";
const char* ENTITY_ID = "vaso-01";
const int   SCHEMA_VERSION = 1;

/*
 * Chave HMAC deste dispositivo (32 bytes em hex). Deve ser IDENTICA a de
 * esp32-vaso-01 em marco-03/seguranca/chaves-hmac.json -- e com ela que o servico
 * confere o que este ESP32 publica e assina os comandos dirigidos a ele.
 */
const char* CHAVE_HMAC_HEX = "0b998eb199cc28c1ba6d8098252467512df59e300d2f41bf97865c9614f8ac26";
uint8_t chaveHmac[32];

/*
 * PREFIXO_TOPICO deve ser IDENTICO ao identidade.prefixoTopico do
 * marco-02/config.json, e o vasoId deve coincidir. Se os dois lados
 * divergirem, o servico simplesmente nao recebe nada -- e o modo de falha mais
 * comum e mais silencioso de uma integracao por topico.
 */
const char* PREFIXO_TOPICO = "naodenemagua/v1";

char topicoTelemetria[96];
char topicoHeartbeat[96];
char topicoComando[96];
char topicoAck[96];

// --------------------------------------------------------------------------
// Parametros de tempo
// --------------------------------------------------------------------------
const unsigned long INTERVALO_TELEMETRIA_MS = 1500;
const unsigned long INTERVALO_HEARTBEAT_MS  = 1500;
const unsigned long LIMIAR_SILENCIO_MS      = 10000;

// --------------------------------------------------------------------------
// Estado
// --------------------------------------------------------------------------
WiFiClientSecure wifiCliente;   // TLS: o PubSubClient escreve por cima dele
PubSubClient mqtt(wifiCliente);

char bootId[9];
uint32_t sequenciaLeitura = 0;
uint32_t sequenciaHeartbeat = 0;
unsigned long ultimaTelemetriaMs = 0;
unsigned long ultimoHeartbeatMs = 0;
unsigned long ultimaLeituraEmitidaMs = 0;

bool bombaLigada = false;
unsigned long fimDoPulsoMs = 0;

char willPayload[352];

/*
 * Buffer offline.
 *
 * Atividade 02, item 12: durante a queda, o dispositivo continua amostrando e
 * enfileira localmente, preservando o eventTimeMs ORIGINAL da medicao. Ao
 * reconectar, reenvia marcando replayed:true -- e o consumidor entao trata
 * esses eventos como historicos, sem deixa-los realimentar a decisao corrente.
 * Preservar o tempo original e o que torna o reenvio honesto: o evento nao
 * finge ter sido medido agora.
 */
const int CAPACIDADE_BUFFER = 24;
struct LeituraEnfileirada {
  uint32_t sequencia;
  unsigned long eventTimeMs;
  float valor;
  bool valida;
};
LeituraEnfileirada buffer[CAPACIDADE_BUFFER];
int bufferInicio = 0;
int bufferTamanho = 0;

/*
 * Idempotencia na recepcao de comando: guarda as ultimas chaves aplicadas.
 * Um retry com a mesma chave NAO repete o efeito fisico.
 */
const int CAPACIDADE_CHAVES = 12;
String chavesAplicadas[CAPACIDADE_CHAVES];
int proximaChave = 0;

// --------------------------------------------------------------------------
// Utilitarios
// --------------------------------------------------------------------------

void gerarBootId() {
  // Identidade desta execucao. Sem ela, dois boots produziriam eventIds iguais.
  snprintf(bootId, sizeof(bootId), "%06x", (unsigned int)(esp_random() & 0xFFFFFF));
}

void montarTopicos() {
  snprintf(topicoTelemetria, sizeof(topicoTelemetria), "%s/vaso/%s/telemetry/soil", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoHeartbeat,  sizeof(topicoHeartbeat),  "%s/vaso/%s/status/heartbeat", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoComando,    sizeof(topicoComando),    "%s/vaso/%s/command/irrigacao", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoAck,        sizeof(topicoAck),        "%s/vaso/%s/ack/irrigacao", PREFIXO_TOPICO, ENTITY_ID);
}

// --------------------------------------------------------------------------
// Assinatura HMAC-SHA256
// --------------------------------------------------------------------------

/*
 * Mesmo formato do lado Node (seguranca/index.js): HMAC de
 * topico + "\n" + corpo, em hex, anexado como ULTIMO campo: ,"sig":"<64 hex>"}
 * Assina-se o texto exato que vai pela rede, entao nao importa que este
 * firmware imprima 20.0 onde o JavaScript imprimiria 20.
 */
void carregarChave() {
  for (int i = 0; i < 32; i++) {
    char par[3] = { CHAVE_HMAC_HEX[2 * i], CHAVE_HMAC_HEX[2 * i + 1], '\0' };
    chaveHmac[i] = (uint8_t)strtoul(par, NULL, 16);
  }
}

void calcularHmacHex(const char* topico, const char* corpo, size_t tamanhoCorpo, char* saidaHex) {
  uint8_t resultado[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, chaveHmac, sizeof(chaveHmac));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)topico, strlen(topico));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)"\n", 1);
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)corpo, tamanhoCorpo);
  mbedtls_md_hmac_finish(&ctx, resultado);
  mbedtls_md_free(&ctx);
  for (int i = 0; i < 32; i++) sprintf(saidaHex + 2 * i, "%02x", resultado[i]);
  saidaHex[64] = '\0';
}

/*
 * Recebe o JSON do corpo em `json` (terminado em '}') e acrescenta a assinatura
 * no proprio buffer. Devolve false se nao couber.
 */
bool assinarNoBuffer(const char* topico, char* json, size_t capacidade) {
  size_t n = strlen(json);
  if (n < 2 || json[n - 1] != '}' || n + 75 >= capacidade) return false;
  char sig[65];
  calcularHmacHex(topico, json, n, sig);
  snprintf(json + n - 1, capacidade - (n - 1), ",\"sig\":\"%s\"}", sig);
  return true;
}

/*
 * Confere a assinatura de uma mensagem recebida. Comparacao em tempo constante:
 * uma comparacao que para no primeiro byte diferente vazaria, pelo tempo,
 * quantos bytes da assinatura estavam certos.
 */
bool assinaturaValida(const char* topico, const char* json) {
  // Sufixo ,"sig":"<64 hex>"} tem 74 caracteres; antes dele, no minimo o '{'.
  size_t n = strlen(json);
  if (n < 75) return false;
  const char* inicio = json + n - 74;  // aponta para a virgula de ,"sig":"
  if (strncmp(inicio, ",\"sig\":\"", 8) != 0 || strcmp(json + n - 2, "\"}") != 0) return false;

  // Corpo assinado = tudo antes de ,"sig":... seguido de '}'.
  size_t tamanhoCorpo = inicio - json;
  char corpo[1024];
  if (tamanhoCorpo + 2 > sizeof(corpo)) return false;
  memcpy(corpo, json, tamanhoCorpo);
  corpo[tamanhoCorpo] = '}';
  corpo[tamanhoCorpo + 1] = '\0';

  char esperado[65];
  calcularHmacHex(topico, corpo, tamanhoCorpo + 1, esperado);

  uint8_t diferenca = 0;
  for (int i = 0; i < 64; i++) diferenca |= (uint8_t)(esperado[i] ^ inicio[8 + i]);
  return diferenca == 0;
}

/* Extrai um numero de um campo JSON, sem biblioteca de parsing. */
long lerCampoNumerico(const char* json, const char* chave, long padrao) {
  char busca[48];
  snprintf(busca, sizeof(busca), "\"%s\":", chave);
  const char* p = strstr(json, busca);
  if (p == NULL) return padrao;
  p += strlen(busca);
  while (*p == ' ') p++;
  return strtol(p, NULL, 10);
}

/* Extrai uma string de um campo JSON, sem biblioteca de parsing. */
bool lerCampoTexto(const char* json, const char* chave, char* destino, size_t tamanho) {
  char busca[48];
  snprintf(busca, sizeof(busca), "\"%s\":\"", chave);
  const char* p = strstr(json, busca);
  if (p == NULL) return false;
  p += strlen(busca);
  const char* fim = strchr(p, '"');
  if (fim == NULL) return false;
  size_t n = fim - p;
  if (n >= tamanho) n = tamanho - 1;
  memcpy(destino, p, n);
  destino[n] = '\0';
  return true;
}

// --------------------------------------------------------------------------
// Leitura
// --------------------------------------------------------------------------

/*
 * Validacao local, no dispositivo (Atividade 02, item 11: fica na borda porque
 * e barata e evita gastar radio transmitindo leitura impossivel).
 *
 * Heuristica: leitura colada num extremo do ADC nao e um padrao fisico
 * esperado de secagem gradual -- sugere sensor desconectado.
 */
int extremoRepetido = 0;

bool lerUmidade(float* valorPct) {
  int bruto = analogRead(PIN_UMIDADE);
  *valorPct = (bruto / 4095.0f) * 100.0f;

  if (bruto <= 1 || bruto >= 4094) extremoRepetido++;
  else extremoRepetido = 0;

  return extremoRepetido < 5;
}

// --------------------------------------------------------------------------
// Publicacao
// --------------------------------------------------------------------------

void publicarTelemetria(uint32_t seq, unsigned long tempoEventoMs, float valor,
                        bool valida, bool replayed) {
  char payload[512];
  int n = snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":%d,"
    "\"eventId\":\"%s:%s:%06lu\","
    "\"eventType\":\"LeituraUmidadeSolo\","
    "\"deviceId\":\"%s\","
    "\"entityId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"eventTimeMs\":%lu,"
    "\"sequence\":%lu,"
    "\"value\":%.1f,"
    "\"unit\":\"pct_simulado\","
    "\"valid\":%s",
    SCHEMA_VERSION, DEVICE_ID, bootId, (unsigned long)seq,
    DEVICE_ID, ENTITY_ID, bootId,
    tempoEventoMs, (unsigned long)seq, valor,
    valida ? "true" : "false");

  if (!valida) {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"invalidReason\":\"sensor_possivelmente_desconectado\"");
  }
  if (replayed) {
    n += snprintf(payload + n, sizeof(payload) - n, ",\"replayed\":true");
  }
  snprintf(payload + n, sizeof(payload) - n, "}");

  if (!assinarNoBuffer(topicoTelemetria, payload, sizeof(payload))) {
    Serial.println("   ERRO: payload grande demais para assinar -- nao publicado");
    return;
  }
  mqtt.publish(topicoTelemetria, payload);
  Serial.print(replayed ? "-> telemetria (replay) " : "-> telemetria ");
  Serial.println(payload);
}

void publicarHeartbeat() {
  sequenciaHeartbeat++;
  unsigned long silencio = millis() - ultimaLeituraEmitidaMs;

  char payload[448];
  snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":%d,"
    "\"eventType\":\"EstadoConectividade\","
    "\"deviceId\":\"%s\","
    "\"entityId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"eventTimeMs\":%lu,"
    "\"sequence\":%lu,"
    "\"value\":%lu,"
    "\"unit\":\"ms_desde_ultimo_evento\","
    "\"state\":\"%s\"}",
    SCHEMA_VERSION, DEVICE_ID, ENTITY_ID, bootId,
    millis(), (unsigned long)sequenciaHeartbeat, silencio,
    silencio > LIMIAR_SILENCIO_MS ? "SILENCIOSO" : "ATIVO");

  // retained: um assinante que chegue depois conhece o estado corrente
  // imediatamente, sem esperar o proximo ciclo.
  if (!assinarNoBuffer(topicoHeartbeat, payload, sizeof(payload))) return;
  mqtt.publish(topicoHeartbeat, payload, true);
}

void publicarAck(const char* commandId, const char* correlationId,
                 const char* resultado, const char* detalhe) {
  char payload[512];
  snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":%d,"
    "\"eventType\":\"ConfirmacaoAtuacao\","
    "\"deviceId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"commandId\":\"%s\","
    "\"correlationId\":\"%s\","
    "\"result\":\"%s\","
    "\"appliedAtDeviceMs\":%lu,"
    "\"detail\":\"%s\"}",
    SCHEMA_VERSION, DEVICE_ID, bootId, commandId, correlationId,
    resultado, millis(), detalhe);

  if (!assinarNoBuffer(topicoAck, payload, sizeof(payload))) return;
  mqtt.publish(topicoAck, payload);
  Serial.print("<- ack ");
  Serial.println(payload);
}

// --------------------------------------------------------------------------
// Buffer offline
// --------------------------------------------------------------------------

void enfileirar(uint32_t seq, unsigned long tempoEventoMs, float valor, bool valida) {
  int posicao = (bufferInicio + bufferTamanho) % CAPACIDADE_BUFFER;
  if (bufferTamanho == CAPACIDADE_BUFFER) {
    // Fila cheia: descarta a medicao MAIS ANTIGA. Numa queda longa, o passado
    // recente orienta melhor a decisao do que o passado remoto.
    bufferInicio = (bufferInicio + 1) % CAPACIDADE_BUFFER;
    posicao = (bufferInicio + bufferTamanho - 1) % CAPACIDADE_BUFFER;
  } else {
    bufferTamanho++;
  }
  buffer[posicao].sequencia = seq;
  buffer[posicao].eventTimeMs = tempoEventoMs;
  buffer[posicao].valor = valor;
  buffer[posicao].valida = valida;
}

void esvaziarBuffer() {
  if (bufferTamanho == 0) return;
  Serial.print("reconectado: reenviando ");
  Serial.print(bufferTamanho);
  Serial.println(" leitura(s) do buffer offline como replayed");

  while (bufferTamanho > 0) {
    LeituraEnfileirada* l = &buffer[bufferInicio];
    publicarTelemetria(l->sequencia, l->eventTimeMs, l->valor, l->valida, true);
    bufferInicio = (bufferInicio + 1) % CAPACIDADE_BUFFER;
    bufferTamanho--;
    mqtt.loop();
    delay(30); // nao afoga o broker publico com uma rajada
  }
}

// --------------------------------------------------------------------------
// Recepcao de comando
// --------------------------------------------------------------------------

bool chaveJaAplicada(const char* chave) {
  for (int i = 0; i < CAPACIDADE_CHAVES; i++) {
    if (chavesAplicadas[i] == chave) return true;
  }
  return false;
}

void registrarChave(const char* chave) {
  chavesAplicadas[proximaChave] = chave;
  proximaChave = (proximaChave + 1) % CAPACIDADE_CHAVES;
}

void aoReceberComando(char* topico, byte* dados, unsigned int tamanho) {
  char json[1024];
  unsigned int n = tamanho < sizeof(json) - 1 ? tamanho : sizeof(json) - 1;
  memcpy(json, dados, n);
  json[n] = '\0';

  Serial.print("<- comando ");
  Serial.println(json);

  char commandId[48] = "desconhecido";
  char correlationId[64] = "desconhecido";
  char acao[32] = "";
  lerCampoTexto(json, "commandId", commandId, sizeof(commandId));
  lerCampoTexto(json, "correlationId", correlationId, sizeof(correlationId));

  /*
   * Autenticidade ANTES de qualquer outra verificacao. No broker publico
   * qualquer pessoa pode publicar neste topico; o que separa o servico de um
   * atacante e a assinatura feita com a chave deste dispositivo. Quem sofre a
   * consequencia fisica e o ESP32, entao a ultima barreira fica aqui.
   */
  if (!assinaturaValida(topicoComando, json)) {
    Serial.println("   assinatura AUSENTE ou INVALIDA -- comando recusado, bomba intocada");
    publicarAck(commandId, correlationId, "REJEITADO_ASSINATURA", "hmac nao confere");
    return;
  }

  long versao = lerCampoNumerico(json, "schemaVersion", -1);
  bool temCampos = strcmp(commandId, "desconhecido") != 0 &&
                   lerCampoTexto(json, "action", acao, sizeof(acao));

  // Versao antes de qualquer outra coisa: um comando de uma versao que este
  // firmware nao entende NAO deve ser interpretado por adivinhacao.
  if (versao != SCHEMA_VERSION || !temCampos) {
    publicarAck(commandId, correlationId, "REJEITADO_CONTRATO", "versao ou campos incompativeis");
    return;
  }

  char chave[48] = "";
  if (!lerCampoTexto(json, "idempotencyKey", chave, sizeof(chave))) {
    publicarAck(commandId, correlationId, "REJEITADO_CONTRATO", "sem idempotencyKey");
    return;
  }

  // Idempotencia. Verificada ANTES da expiracao de proposito: se a chave ja foi
  // aplicada, o resultado correto e "duplicado", nao "expirado" -- o efeito ja
  // existe e essa e a informacao relevante para quem reenviou.
  if (chaveJaAplicada(chave)) {
    Serial.println("   chave idempotente ja aplicada -- efeito NAO repetido");
    publicarAck(commandId, correlationId, "IGNORADO_DUPLICADO", "idempotencyKey ja aplicada");
    return;
  }

  /*
   * Expiracao no relogio do PROPRIO dispositivo.
   *
   * O servico nao envia um instante do seu relogio (que este dispositivo nao
   * tem como interpretar, por nao haver NTP): envia o prazo ancorado no
   * eventTimeMs do evento que originou a decisao. A comparacao abaixo usa
   * apenas millis() local.
   */
  long expiraEm = lerCampoNumerico(json, "expiresAtDeviceMs", -1);
  if (expiraEm >= 0 && (long)millis() >= expiraEm) {
    Serial.print("   comando EXPIRADO (prazo ");
    Serial.print(expiraEm);
    Serial.print("ms, agora ");
    Serial.print(millis());
    Serial.println("ms) -- nao atua tarde");
    publicarAck(commandId, correlationId, "REJEITADO_EXPIRADO", "prazo do dispositivo vencido");
    return;
  }

  registrarChave(chave);

  if (strcmp(acao, "PULSO_IRRIGACAO") == 0) {
    long duracao = lerCampoNumerico(json, "durationMs", 3000);
    bombaLigada = true;
    fimDoPulsoMs = millis() + duracao;
    digitalWrite(PIN_LED_BOMBA, HIGH);
    Serial.print("   BOMBA LIGADA por ");
    Serial.print(duracao);
    Serial.println("ms");
    publicarAck(commandId, correlationId, "EXECUTADO", "PULSO_IRRIGACAO");
  } else if (strcmp(acao, "PARAR_IRRIGACAO") == 0) {
    bombaLigada = false;
    fimDoPulsoMs = 0;
    digitalWrite(PIN_LED_BOMBA, LOW);
    Serial.println("   BOMBA DESLIGADA");
    publicarAck(commandId, correlationId, "EXECUTADO", "PARAR_IRRIGACAO");
  } else {
    publicarAck(commandId, correlationId, "REJEITADO_CONTRATO", "acao desconhecida");
  }
}

// --------------------------------------------------------------------------
// Conexao
// --------------------------------------------------------------------------

void conectarWiFi() {
  Serial.print("Wi-Fi: conectando");
  WiFi.begin(WIFI_SSID, WIFI_SENHA, WIFI_CANAL);
  while (WiFi.status() != WL_CONNECTED) {
    delay(200);
    Serial.print(".");
  }
  Serial.print(" conectado, IP ");
  Serial.println(WiFi.localIP());
}

/*
 * Reconexao com backoff. O dispositivo nao para de amostrar durante a queda --
 * ele enfileira. Tentar reconectar em rajada apertada gastaria radio (o maior
 * consumidor de energia do ESP32) sem aumentar a chance de sucesso.
 */
unsigned long proximaTentativaMs = 0;
unsigned long esperaBackoffMs = 1000;
const unsigned long BACKOFF_MAXIMO_MS = 16000;

void montarWillPayload() {
  snprintf(willPayload, sizeof(willPayload),
    "{\"schemaVersion\":%d,"
    "\"eventType\":\"EstadoConectividade\","
    "\"deviceId\":\"%s\","
    "\"entityId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"state\":\"OFFLINE\","
    "\"reason\":\"lwt_conexao_encerrada_sem_disconnect\"}",
    SCHEMA_VERSION, DEVICE_ID, ENTITY_ID, bootId);
  // Assinada AGORA, no dispositivo: o broker apenas a repassa na queda. Sem a
  // assinatura, qualquer um poderia publicar um OFFLINE falso para este vaso.
  assinarNoBuffer(topicoHeartbeat, willPayload, sizeof(willPayload));
}

bool conectarBroker() {
  char clientId[64];
  snprintf(clientId, sizeof(clientId), "%s-%s", DEVICE_ID, bootId);

  Serial.print("MQTT: conectando a ");
  Serial.print(BROKER_HOST);
  Serial.print(" como ");
  Serial.println(clientId);

  /*
   * A will message e registrada no CONNECT. Quem a publica e o BROKER, e
   * somente se a conexao terminar sem DISCONNECT. retain=true para que o
   * estado OFFLINE fique disponivel a qualquer assinante que chegue depois.
   */
  bool ok = mqtt.connect(clientId, topicoHeartbeat, 1, true, willPayload);

  if (ok) {
    Serial.println("MQTT: conectado, will message registrada");
    digitalWrite(PIN_LED_STATUS, HIGH);
    mqtt.subscribe(topicoComando, 1);
    Serial.print("MQTT: assinando ");
    Serial.println(topicoComando);
    esperaBackoffMs = 1000;
    esvaziarBuffer();
  } else {
    Serial.print("MQTT: falhou, rc=");
    Serial.println(mqtt.state());
    digitalWrite(PIN_LED_STATUS, LOW);
  }
  return ok;
}

// --------------------------------------------------------------------------
// setup / loop
// --------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_LED_BOMBA, OUTPUT);
  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_BOMBA, LOW);
  digitalWrite(PIN_LED_STATUS, LOW);
  analogReadResolution(12);

  carregarChave();
  gerarBootId();
  montarTopicos();
  montarWillPayload();

  Serial.println();
  Serial.println("gateway-vaso -- produtor do Marco 2");
  Serial.print("  deviceId ");
  Serial.println(DEVICE_ID);
  Serial.print("  bootId   ");
  Serial.println(bootId);
  Serial.print("  publica  ");
  Serial.println(topicoTelemetria);
  Serial.print("  assina   ");
  Serial.println(topicoComando);
  Serial.println();

  conectarWiFi();

  /*
   * O buffer padrao do PubSubClient e de 256 bytes e os payloads deste contrato
   * passam disso. Sem este ajuste, publish() falha silenciosamente e a
   * integracao "nao funciona" sem qualquer erro visivel.
   */
  mqtt.setBufferSize(1024);  // comando assinado passa de 512 bytes

  // TLS: confere a cadeia do broker contra a CA raiz e o nome do host.
  wifiCliente.setCACert(CA_RAIZ_BROKER);
  mqtt.setServer(BROKER_HOST, BROKER_PORTA);
  mqtt.setCallback(aoReceberComando);
  mqtt.setKeepAlive(15);

  conectarBroker();
  ultimaLeituraEmitidaMs = millis();
}

void loop() {
  unsigned long agora = millis();

  // Encerramento do pulso: a bomba desliga sozinha ao fim da duracao comandada.
  if (bombaLigada && fimDoPulsoMs != 0 && agora >= fimDoPulsoMs) {
    bombaLigada = false;
    fimDoPulsoMs = 0;
    digitalWrite(PIN_LED_BOMBA, LOW);
    Serial.println("   pulso encerrado, BOMBA DESLIGADA");
  }

  bool conectado = mqtt.connected();

  if (!conectado) {
    digitalWrite(PIN_LED_STATUS, LOW);
    if (agora >= proximaTentativaMs) {
      if (!conectarBroker()) {
        proximaTentativaMs = agora + esperaBackoffMs;
        esperaBackoffMs = esperaBackoffMs * 2 > BACKOFF_MAXIMO_MS
                            ? BACKOFF_MAXIMO_MS
                            : esperaBackoffMs * 2;
        Serial.print("   proxima tentativa em ");
        Serial.print(esperaBackoffMs);
        Serial.println("ms (backoff)");
      }
    }
  } else {
    mqtt.loop();
  }

  // Amostragem: acontece SEMPRE, conectado ou nao.
  if (agora - ultimaTelemetriaMs >= INTERVALO_TELEMETRIA_MS) {
    ultimaTelemetriaMs = agora;

    float valor;
    bool valida = lerUmidade(&valor);
    sequenciaLeitura++;

    if (mqtt.connected()) {
      publicarTelemetria(sequenciaLeitura, agora, valor, valida, false);
      ultimaLeituraEmitidaMs = agora;
    } else {
      // Sem rede a medicao nao se perde: entra na fila com o tempo ORIGINAL.
      enfileirar(sequenciaLeitura, agora, valor, valida);
      Serial.print("   offline: leitura ");
      Serial.print(sequenciaLeitura);
      Serial.print(" enfileirada (fila com ");
      Serial.print(bufferTamanho);
      Serial.println(" itens)");
    }
  }

  if (mqtt.connected() && agora - ultimoHeartbeatMs >= INTERVALO_HEARTBEAT_MS) {
    ultimoHeartbeatMs = agora;
    publicarHeartbeat();
  }

  delay(50);
}

/*
 * gateway-vaso -- COMPONENTE PRODUTOR, caminho B (dispositivo real no Wokwi).
 *
 * Projeto do grupo: "Nao de nem agua" -- cuidado assistido de plantas de interior.
 * Disciplina: Software para Sistemas Ubiquos (UFG).
 *
 * MARCO 4 -- O QUE ESTE FIRMWARE GANHOU
 * -------------------------------------
 * Sensores: sonda de solo 3-em-1 SIMULADA (custom chip: umidade, temperatura e
 * condutividade eletrica = nutrientes), DHT22 (ar) e dois HC-SR04 (nivel dos
 * reservatorios de agua e de fertilizante). Atuadores: tres reles -- bomba de
 * agua, bomba de fertilizante e umidificador.
 *
 * A distribuicao de responsabilidades do Marco 3 se mantem: a DECISAO continua
 * no servico. O dispositivo ganhou validacao local mais rica (sonda travada,
 * ruidosa, desconectada; mediana do ultrassom) e PROTECOES FISICAS LOCAIS, que
 * valem mesmo sem rede e mesmo diante de um comando autentico:
 *   - bomba de agua nao liga (e para no meio) com o reservatorio de agua critico;
 *   - bomba de adubo nao liga com o reservatorio de adubo critico, com a bomba
 *     de agua ligada (intertravamento) ou com o solo seco (< 35%, queima a raiz);
 *   - umidificador so liga por CONCESSAO (desliga sozinho se nao for renovado)
 *     e desliga se o DHT22 falhar.
 * Um comando que violaria essas regras recebe REJEITADO_SEGURANCA.
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
 * 1. ENTRADA SUBSTITUTA: o Wokwi nao possui higrometro capacitivo nem sensor de
 *    condutividade. Um CUSTOM CHIP (sonda-solo.chip.c) representa, de forma
 *    ficticia, umidade, temperatura e EC do substrato, a partir de sliders.
 *    Nao ha aquisicao real dessas grandezas. DHT22 e HC-SR04 sao componentes
 *    do Wokwi, mas os valores tambem vem de sliders da simulacao.
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
 * 5. Os reles acendem LEDs que representam bomba, dose e umidificador. Nao ha
 *    agua nem realimentacao fisica: no Wokwi, quem "rega" e quem move o slider.
 * 6. Buffer offline so guarda a telemetria de SOLO (sem os campos de EC, que
 *    sao opcionais). Ar e nivel descrevem o estado corrente e nao sao
 *    reenviados: um replay nao decide nada no servico.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "mbedtls/md.h"
#include "DHTesp.h"
#include "sonda_solo.h"
#include "reservatorios.h"

// --------------------------------------------------------------------------
// Pinos (sonda de solo: 34/35/32, em sonda_solo.h)
// --------------------------------------------------------------------------
const int PIN_DHT            = 15;
const int PIN_AGUA_TRIG      = 5;
const int PIN_AGUA_ECHO      = 18;
const int PIN_ADUBO_TRIG     = 17;
const int PIN_ADUBO_ECHO     = 16;
const int PIN_LED_BOMBA      = 26;  // rele da bomba de agua (nome mantido do Marco 3)
const int PIN_RELE_ADUBO     = 27;  // rele da bomba de fertilizante
const int PIN_RELE_UMIDIF    = 33;  // rele do umidificador
const int PIN_LED_STATUS     = 25;  // aceso = conectado ao broker
const int PIN_LED_PROTECAO   = 13;  // aceso = alguma protecao local ativa

// --------------------------------------------------------------------------
// Protecoes fisicas locais (independem do servico e da rede)
// --------------------------------------------------------------------------
const float NIVEL_CRITICO_LOCAL_PCT = 10.0f;
const float UMIDADE_MIN_ADUBAR_PCT  = 35.0f;
const unsigned long DOSE_MAXIMA_MS       = 10000;
const unsigned long CONCESSAO_MAXIMA_MS  = 120000;
const int FALHAS_DHT_PARA_DESLIGAR       = 3;

// Geometria dos tanques: folga = sensor ate a superficie com o tanque CHEIO.
Reservatorio reservAgua("AGUA", PIN_AGUA_TRIG, PIN_AGUA_ECHO, 30.0f, 3.0f);
Reservatorio reservAdubo("ADUBO", PIN_ADUBO_TRIG, PIN_ADUBO_ECHO, 15.0f, 3.0f);
MonitorSonda monitorSonda;
DHTesp dht;

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
 * esp32-vaso-01 em marco-04/seguranca/chaves-hmac.json -- e com ela que o servico
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
// Marco 4
char topicoAmbiente[96];
char topicoNivel[96];
char topicoComandoAtuador[96];
char topicoAckAtuador[96];

// --------------------------------------------------------------------------
// Parametros de tempo
// --------------------------------------------------------------------------
const unsigned long INTERVALO_TELEMETRIA_MS = 1500;
const unsigned long INTERVALO_HEARTBEAT_MS  = 1500;
const unsigned long LIMIAR_SILENCIO_MS      = 10000;
const unsigned long INTERVALO_AMBIENTE_MS   = 2000;  // minimo do DHT22
const unsigned long INTERVALO_NIVEL_MS      = 1500;
const unsigned long AMOSTRAGEM_NIVEL_MS     = 100;   // alterna os dois HC-SR04

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

// Marco 4
bool aduboLigado = false;
unsigned long fimDaDoseMs = 0;
bool umidificadorLigado = false;
unsigned long fimDaConcessaoMs = 0;
int falhasDhtSeguidas = 0;
LeituraSolo ultimaSolo;
bool temLeituraSolo = false;
unsigned long ultimoAmbienteMs = 0;
unsigned long ultimoNivelMs = 0;
unsigned long ultimaAmostraNivelMs = 0;
bool amostrarAguaAgora = true;

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
  snprintf(topicoAmbiente,   sizeof(topicoAmbiente),   "%s/vaso/%s/telemetry/ambient", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoNivel,      sizeof(topicoNivel),      "%s/vaso/%s/telemetry/reservoir", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoComandoAtuador, sizeof(topicoComandoAtuador), "%s/vaso/%s/command/atuador", PREFIXO_TOPICO, ENTITY_ID);
  snprintf(topicoAckAtuador, sizeof(topicoAckAtuador), "%s/vaso/%s/ack/atuador", PREFIXO_TOPICO, ENTITY_ID);
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
 * Marco 4: a heuristica de "valor colado no extremo" do potenciometro deu lugar
 * ao diagnostico da sonda (sonda_solo.h): desconectada, fora da faixa, travada
 * ou ruidosa. Qualquer um deles marca a leitura como valid:false.
 */
const char* motivoInvalidoSolo = "";

bool lerUmidade(float* valorPct) {
  ultimaSolo = lerSondaSolo();
  temLeituraSolo = true;
  monitorSonda.registrar(ultimaSolo);
  *valorPct = ultimaSolo.umidadePct;
  bool valida = ultimaSolo.valida && !monitorSonda.emFalha();
  motivoInvalidoSolo = !ultimaSolo.valida ? ultimaSolo.motivoInvalido : monitorSonda.motivo();
  return valida;
}

// --------------------------------------------------------------------------
// Publicacao
// --------------------------------------------------------------------------

/*
 * Marco 4: sequence UNICO para solo, ar e nivel. Assim o eventId
 * (deviceId:bootId:sequence) nunca se repete entre os tres eventos, e o
 * servico deduplica todos com o mesmo conjunto.
 */
uint32_t proximaSequencia() {
  return ++sequenciaLeitura;
}

void publicarTelemetria(uint32_t seq, unsigned long tempoEventoMs, float valor,
                        bool valida, bool replayed, const LeituraSolo* atual) {
  char payload[768];
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
                  ",\"invalidReason\":\"%s\"", replayed ? "sensor_invalido" : motivoInvalidoSolo);
  }
  // Marco 4: campos opcionais da v1 com temperatura do solo e EC. So na
  // leitura corrente e valida -- sem leitura confiavel, nada de numero inventado.
  if (atual != NULL && valida) {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"soilTempC\":%.1f,\"ecApparentUsCm\":%.0f,\"ecValid\":%s",
                  atual->temperaturaC, atual->ecAparente, atual->ecValida ? "true" : "false");
    if (atual->ecValida) {
      n += snprintf(payload + n, sizeof(payload) - n, ",\"ec25UsCm\":%.0f", atual->ec25);
    } else {
      n += snprintf(payload + n, sizeof(payload) - n, ",\"ecInvalidReason\":\"%s\"", atual->motivoEcInvalida);
    }
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

/* Marco 4: LeituraAmbiente (DHT22). Sem leitura valida, so valid:false. */
void publicarAmbiente(bool valida, float temperatura, float umidade) {
  uint32_t seq = proximaSequencia();
  char payload[640];
  int n = snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":%d,"
    "\"eventId\":\"%s:%s:%06lu\","
    "\"eventType\":\"LeituraAmbiente\","
    "\"deviceId\":\"%s\","
    "\"entityId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"eventTimeMs\":%lu,"
    "\"sequence\":%lu",
    SCHEMA_VERSION, DEVICE_ID, bootId, (unsigned long)seq,
    DEVICE_ID, ENTITY_ID, bootId, millis(), (unsigned long)seq);
  if (valida) {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"temperatureC\":%.1f,\"humidityPct\":%.1f,\"valid\":true}", temperatura, umidade);
  } else {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"valid\":false,\"invalidReason\":\"dht22_sem_resposta\"}");
  }
  if (!assinarNoBuffer(topicoAmbiente, payload, sizeof(payload))) return;
  mqtt.publish(topicoAmbiente, payload);
  Serial.print("-> ar ");
  Serial.println(payload);
}

/* Marco 4: NivelReservatorio (HC-SR04, mediana ja aplicada). */
void publicarNivel(Reservatorio& r) {
  uint32_t seq = proximaSequencia();
  char payload[640];
  int n = snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":%d,"
    "\"eventId\":\"%s:%s:%06lu\","
    "\"eventType\":\"NivelReservatorio\","
    "\"deviceId\":\"%s\","
    "\"entityId\":\"%s\","
    "\"bootId\":\"%s\","
    "\"eventTimeMs\":%lu,"
    "\"sequence\":%lu,"
    "\"reservoir\":\"%s\"",
    SCHEMA_VERSION, DEVICE_ID, bootId, (unsigned long)seq,
    DEVICE_ID, ENTITY_ID, bootId, millis(), (unsigned long)seq, r.nome());
  if (r.conhecido()) {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"distanceCm\":%.1f,\"levelPct\":%.1f,\"valid\":true}", r.distanciaCm(), r.nivelPct());
  } else {
    n += snprintf(payload + n, sizeof(payload) - n,
                  ",\"valid\":false,\"invalidReason\":\"sem_eco_valido\"}");
  }
  if (!assinarNoBuffer(topicoNivel, payload, sizeof(payload))) return;
  mqtt.publish(topicoNivel, payload);
}

void publicarAck(const char* topicoResposta, const char* commandId, const char* correlationId,
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

  if (!assinarNoBuffer(topicoResposta, payload, sizeof(payload))) return;
  mqtt.publish(topicoResposta, payload);
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
    publicarTelemetria(l->sequencia, l->eventTimeMs, l->valor, l->valida, true, NULL);
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

// --------------------------------------------------------------------------
// Marco 4: atuadores e protecoes fisicas locais
// --------------------------------------------------------------------------

void ligarBomba(unsigned long duracao) {
  bombaLigada = true;
  fimDoPulsoMs = millis() + duracao;
  digitalWrite(PIN_LED_BOMBA, HIGH);
}

void desligarBomba(const char* motivo) {
  if (!bombaLigada) return;
  bombaLigada = false;
  fimDoPulsoMs = 0;
  digitalWrite(PIN_LED_BOMBA, LOW);
  Serial.print("   BOMBA DESLIGADA (");
  Serial.print(motivo);
  Serial.println(")");
}

void desligarAdubo(const char* motivo) {
  if (!aduboLigado) return;
  aduboLigado = false;
  fimDaDoseMs = 0;
  digitalWrite(PIN_RELE_ADUBO, LOW);
  Serial.print("   BOMBA DE ADUBO DESLIGADA (");
  Serial.print(motivo);
  Serial.println(")");
}

void desligarUmidificador(const char* motivo) {
  if (!umidificadorLigado) return;
  umidificadorLigado = false;
  fimDaConcessaoMs = 0;
  digitalWrite(PIN_RELE_UMIDIF, LOW);
  Serial.print("   UMIDIFICADOR DESLIGADO (");
  Serial.print(motivo);
  Serial.println(")");
}

bool aguaCritica() {
  return reservAgua.conhecido() && reservAgua.nivelPct() <= NIVEL_CRITICO_LOCAL_PCT;
}

bool aduboCritico() {
  return reservAdubo.conhecido() && reservAdubo.nivelPct() <= NIVEL_CRITICO_LOCAL_PCT;
}

/*
 * O comando e autentico e esta no prazo, mas executa-lo seria perigoso?
 * Devolve o motivo (vai no detail do REJEITADO_SEGURANCA) ou NULL.
 * Nivel DESCONHECIDO (sem eco valido) tambem bloqueia as bombas: na duvida,
 * nao se liga bomba a seco.
 */
const char* motivoInseguro(const char* alvo, const char* acao) {
  if (strcmp(alvo, "BOMBA_AGUA") == 0 && strcmp(acao, "PULSO_IRRIGACAO") == 0) {
    if (!reservAgua.conhecido()) return "nivel_agua_desconhecido";
    if (aguaCritica()) return "reservatorio_agua_critico";
    if (aduboLigado) return "intertravamento_bomba_adubo";
  }
  if (strcmp(alvo, "BOMBA_ADUBO") == 0 && strcmp(acao, "PULSO") == 0) {
    if (!reservAdubo.conhecido()) return "nivel_adubo_desconhecido";
    if (aduboCritico()) return "reservatorio_adubo_critico";
    if (bombaLigada) return "intertravamento_bomba_agua";
    if (!temLeituraSolo || !ultimaSolo.valida || monitorSonda.emFalha()) return "sonda_solo_invalida";
    if (ultimaSolo.umidadePct < UMIDADE_MIN_ADUBAR_PCT) return "solo_seco_nao_adubar";
  }
  if (strcmp(alvo, "UMIDIFICADOR") == 0 && strcmp(acao, "LIGAR") == 0) {
    if (falhasDhtSeguidas >= FALHAS_DHT_PARA_DESLIGAR) return "sensor_ar_invalido";
  }
  return NULL;
}

/*
 * Roda a cada volta do loop, com ou sem rede: o efeito fisico nao espera o
 * servico. Encerra pulso/dose/concessao no prazo e corta a bomba que ficou
 * sem agua no meio do caminho.
 */
void aplicarProtecoesLocais(unsigned long agora) {
  if (bombaLigada && fimDoPulsoMs != 0 && agora >= fimDoPulsoMs) desligarBomba("pulso encerrado");
  if (bombaLigada && aguaCritica()) desligarBomba("reservatorio de agua chegou ao critico");
  if (aduboLigado && agora >= fimDaDoseMs) desligarAdubo("dose concluida");
  if (aduboLigado && aduboCritico()) desligarAdubo("reservatorio de adubo chegou ao critico");
  if (umidificadorLigado && agora >= fimDaConcessaoMs) desligarUmidificador("concessao vencida sem renovacao");
  if (umidificadorLigado && falhasDhtSeguidas >= FALHAS_DHT_PARA_DESLIGAR) desligarUmidificador("DHT22 em falha");

  bool protecaoAtiva = aguaCritica() || aduboCritico() || monitorSonda.emFalha() ||
                       falhasDhtSeguidas >= FALHAS_DHT_PARA_DESLIGAR ||
                       !reservAgua.conhecido() || !reservAdubo.conhecido();
  digitalWrite(PIN_LED_PROTECAO, protecaoAtiva ? HIGH : LOW);
}

// --------------------------------------------------------------------------
// Recepcao de comando (command/irrigacao e, no Marco 4, command/atuador)
// --------------------------------------------------------------------------

void aoReceberComando(char* topico, byte* dados, unsigned int tamanho) {
  char json[1024];
  unsigned int n = tamanho < sizeof(json) - 1 ? tamanho : sizeof(json) - 1;
  memcpy(json, dados, n);
  json[n] = '\0';

  bool ehAtuador = strcmp(topico, topicoComandoAtuador) == 0;
  const char* topicoResposta = ehAtuador ? topicoAckAtuador : topicoAck;

  Serial.print("<- comando ");
  Serial.println(json);

  char commandId[48] = "desconhecido";
  char correlationId[64] = "desconhecido";
  char acao[32] = "";
  char tipo[32] = "";
  char alvo[32] = "BOMBA_AGUA";
  lerCampoTexto(json, "commandId", commandId, sizeof(commandId));
  lerCampoTexto(json, "correlationId", correlationId, sizeof(correlationId));

  /*
   * Autenticidade ANTES de qualquer outra verificacao. No broker publico
   * qualquer pessoa pode publicar neste topico; o que separa o servico de um
   * atacante e a assinatura feita com a chave deste dispositivo. O topico entra
   * na assinatura: um comando assinado para command/irrigacao nao vale em
   * command/atuador.
   */
  if (!assinaturaValida(topico, json)) {
    Serial.println("   assinatura AUSENTE ou INVALIDA -- comando recusado, atuadores intocados");
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_ASSINATURA", "hmac nao confere");
    return;
  }

  long versao = lerCampoNumerico(json, "schemaVersion", -1);
  bool temCampos = strcmp(commandId, "desconhecido") != 0 &&
                   lerCampoTexto(json, "action", acao, sizeof(acao)) &&
                   lerCampoTexto(json, "commandType", tipo, sizeof(tipo)) &&
                   strcmp(tipo, ehAtuador ? "ComandoAtuador" : "ComandoIrrigacao") == 0 &&
                   (!ehAtuador || lerCampoTexto(json, "actuator", alvo, sizeof(alvo)));

  // Versao antes de qualquer outra coisa: um comando de uma versao que este
  // firmware nao entende NAO deve ser interpretado por adivinhacao.
  if (versao != SCHEMA_VERSION || !temCampos) {
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_CONTRATO", "versao ou campos incompativeis");
    return;
  }

  char chave[48] = "";
  if (!lerCampoTexto(json, "idempotencyKey", chave, sizeof(chave))) {
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_CONTRATO", "sem idempotencyKey");
    return;
  }

  // Idempotencia. Verificada ANTES da expiracao de proposito: se a chave ja foi
  // aplicada, o resultado correto e "duplicado", nao "expirado" -- o efeito ja
  // existe e essa e a informacao relevante para quem reenviou.
  if (chaveJaAplicada(chave)) {
    Serial.println("   chave idempotente ja aplicada -- efeito NAO repetido");
    publicarAck(topicoResposta, commandId, correlationId, "IGNORADO_DUPLICADO", "idempotencyKey ja aplicada");
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
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_EXPIRADO", "prazo do dispositivo vencido");
    return;
  }

  /*
   * Marco 4: protecao fisica local. A chave NAO e registrada quando o comando
   * e recusado aqui: se a condicao mudar, um reenvio e avaliado de novo.
   */
  const char* inseguro = motivoInseguro(alvo, acao);
  if (inseguro != NULL) {
    Serial.print("   comando autentico, mas INSEGURO agora: ");
    Serial.println(inseguro);
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_SEGURANCA", inseguro);
    return;
  }

  registrarChave(chave);
  long duracao = lerCampoNumerico(json, "durationMs", 3000);

  if (!ehAtuador && strcmp(acao, "PULSO_IRRIGACAO") == 0) {
    ligarBomba(duracao);
    Serial.print("   BOMBA LIGADA por ");
    Serial.print(duracao);
    Serial.println("ms");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "PULSO_IRRIGACAO");
  } else if (!ehAtuador && strcmp(acao, "PARAR_IRRIGACAO") == 0) {
    desligarBomba("comando PARAR_IRRIGACAO");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "PARAR_IRRIGACAO");
  } else if (ehAtuador && strcmp(alvo, "UMIDIFICADOR") == 0 && strcmp(acao, "LIGAR") == 0) {
    unsigned long prazo = duracao > (long)CONCESSAO_MAXIMA_MS ? CONCESSAO_MAXIMA_MS : (unsigned long)duracao;
    umidificadorLigado = true;
    fimDaConcessaoMs = millis() + prazo;
    digitalWrite(PIN_RELE_UMIDIF, HIGH);
    Serial.print("   UMIDIFICADOR LIGADO, concessao de ");
    Serial.print(prazo);
    Serial.println("ms");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "UMIDIFICADOR_LIGAR");
  } else if (ehAtuador && strcmp(alvo, "UMIDIFICADOR") == 0 && strcmp(acao, "DESLIGAR") == 0) {
    desligarUmidificador("comando DESLIGAR");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "UMIDIFICADOR_DESLIGAR");
  } else if (ehAtuador && strcmp(alvo, "BOMBA_ADUBO") == 0 && strcmp(acao, "PULSO") == 0) {
    unsigned long dose = duracao > (long)DOSE_MAXIMA_MS ? DOSE_MAXIMA_MS : (unsigned long)duracao;
    aduboLigado = true;
    fimDaDoseMs = millis() + dose;
    digitalWrite(PIN_RELE_ADUBO, HIGH);
    Serial.print("   BOMBA DE ADUBO LIGADA por ");
    Serial.print(dose);
    Serial.println("ms");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "BOMBA_ADUBO_PULSO");
  } else if (ehAtuador && strcmp(alvo, "BOMBA_ADUBO") == 0 && strcmp(acao, "DESLIGAR") == 0) {
    desligarAdubo("comando DESLIGAR");
    publicarAck(topicoResposta, commandId, correlationId, "EXECUTADO", "BOMBA_ADUBO_DESLIGAR");
  } else {
    publicarAck(topicoResposta, commandId, correlationId, "REJEITADO_CONTRATO", "acao desconhecida");
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
    mqtt.subscribe(topicoComandoAtuador, 1);
    Serial.print("MQTT: assinando ");
    Serial.print(topicoComando);
    Serial.print(" e ");
    Serial.println(topicoComandoAtuador);
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

  const int saidas[] = { PIN_LED_BOMBA, PIN_RELE_ADUBO, PIN_RELE_UMIDIF, PIN_LED_STATUS, PIN_LED_PROTECAO };
  for (int pino : saidas) {
    pinMode(pino, OUTPUT);
    digitalWrite(pino, LOW);
  }
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);  // faixa ~0-3,3 V para a sonda de solo
  dht.setup(PIN_DHT, DHTesp::DHT22);
  reservAgua.begin();
  reservAdubo.begin();

  carregarChave();
  gerarBootId();
  montarTopicos();
  montarWillPayload();

  Serial.println();
  Serial.println("gateway-vaso -- produtor do Marco 4");
  Serial.print("  deviceId ");
  Serial.println(DEVICE_ID);
  Serial.print("  bootId   ");
  Serial.println(bootId);
  Serial.print("  publica  ");
  Serial.println(topicoTelemetria);
  Serial.print("           ");
  Serial.println(topicoAmbiente);
  Serial.print("           ");
  Serial.println(topicoNivel);
  Serial.print("  assina   ");
  Serial.println(topicoComando);
  Serial.print("           ");
  Serial.println(topicoComandoAtuador);
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

  // Fim de pulso/dose/concessao e protecoes fisicas: SEMPRE, com ou sem rede.
  aplicarProtecoesLocais(agora);

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
    uint32_t seq = proximaSequencia();

    if (mqtt.connected()) {
      publicarTelemetria(seq, agora, valor, valida, false, &ultimaSolo);
      ultimaLeituraEmitidaMs = agora;
    } else {
      // Sem rede a medicao nao se perde: entra na fila com o tempo ORIGINAL.
      enfileirar(seq, agora, valor, valida);
      Serial.print("   offline: leitura ");
      Serial.print(seq);
      Serial.print(" enfileirada (fila com ");
      Serial.print(bufferTamanho);
      Serial.println(" itens)");
    }
  }

  // Marco 4: ar (DHT22). A falha conta mesmo offline: e ela que desliga o
  // umidificador localmente (aplicarProtecoesLocais).
  if (agora - ultimoAmbienteMs >= INTERVALO_AMBIENTE_MS) {
    ultimoAmbienteMs = agora;
    TempAndHumidity th = dht.getTempAndHumidity();
    bool ok = dht.getStatus() == DHTesp::ERROR_NONE && !isnan(th.temperature) && !isnan(th.humidity) &&
              th.humidity >= 0 && th.humidity <= 100 && th.temperature >= -40 && th.temperature <= 80;
    falhasDhtSeguidas = ok ? 0 : falhasDhtSeguidas + 1;
    if (mqtt.connected()) publicarAmbiente(ok, th.temperature, th.humidity);
  }

  // Marco 4: os dois HC-SR04 sao amostrados alternadamente (sem eco cruzado);
  // a amostragem segue offline porque o nivel critico protege a bomba.
  if (agora - ultimaAmostraNivelMs >= AMOSTRAGEM_NIVEL_MS) {
    ultimaAmostraNivelMs = agora;
    if (amostrarAguaAgora) reservAgua.amostrar();
    else reservAdubo.amostrar();
    amostrarAguaAgora = !amostrarAguaAgora;
  }
  if (mqtt.connected() && agora - ultimoNivelMs >= INTERVALO_NIVEL_MS) {
    ultimoNivelMs = agora;
    publicarNivel(reservAgua);
    publicarNivel(reservAdubo);
  }

  if (mqtt.connected() && agora - ultimoHeartbeatMs >= INTERVALO_HEARTBEAT_MS) {
    ultimoHeartbeatMs = agora;
    publicarHeartbeat();
  }

  delay(50);
}

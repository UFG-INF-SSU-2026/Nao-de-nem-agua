/*
 * Atividade 03 - Software para Sistemas Ubiquos (UFG)
 * Estudante: Matheus Vieira Mendes Pacheco (matricula final 3)
 * Perfil negociado: Comunicacao e resiliencia
 * Recorte: Heartbeat e deteccao de SILENCIO do sensor de ambiente (luz/temperatura)
 *
 * Projeto do grupo: "Nao de nem agua"
 *
 * Sensores: LDR (luminosidade) + DHT22 (temperatura/umidade do ar) do vaso -
 * o mesmo par de leituras do evento "LeituraAmbiente" da Atividade 02.
 *
 * PIN_BOTAO_SIMULA_DESCONEXAO: usado SO no teste adversarial. Enquanto
 * pressionado, o dispositivo "para de falar" (nao emite novas leituras de
 * ambiente), simulando perda de conectividade / sensor silencioso - o
 * mesmo risco principal ja identificado nas Atividades 01 e 02.
 *
 * Ciclo implementado:
 *   fenomeno (luz/temperatura do ambiente do vaso)
 *     -> LDR + DHT22
 *     -> leitura + validacao (DHT invalido = NaN)
 *     -> evento JSON (LeituraAmbiente)
 *     -> estado + regra (heartbeat: expira leitura + debounce da transicao
 *        + cooldown do alerta, para nao disparar em rajada)
 *     -> decisao
 *     -> atuacao (LED de status + buzzer de alerta)
 *
 * LIMITACAO DECLARADA: em producao, o limiar de silencio de um gateway real
 * seria de minutos (nao segundos). Aqui os parametros de tempo (limiar,
 * ciclo de leitura, cooldown) foram reduzidos para segundos/centesimos de
 * segundo de propósito, para que o teste manual no Wokwi (clicando o botao)
 * seja possivel em poucos segundos. A LOGICA da regra (debounce + cooldown)
 * e identica a que seria usada com os tempos reais, maiores.
 */

#include "DHTesp.h"

const int PIN_LDR = 35;
const int PIN_DHT = 15;
const int PIN_BOTAO_SIMULA_DESCONEXAO = 27; // pressionado (HIGH) = "sensor calado"
const int PIN_LED_STATUS = 26;              // aceso = dispositivo "vivo"
const int PIN_BUZZER     = 25;              // bipe = transicao para SILENCIOSO

DHTesp dht;

const char* DEVICE_ID = "esp32-vaso-matheus";
const char* ENTITY_ID = "vaso-matheus-01";

// --- Parametros da regra (ajustados p/ teste manual - ver limitacao acima) ---
const unsigned long LIMIAR_SILENCIO_MS  = 600;  // sem novo evento por > 0.6s = parece silencioso
const int CICLOS_DEBOUNCE = 4;                  // ciclos consecutivos p/ confirmar a transicao (4 x 150ms = 0.6s)
const unsigned long COOLDOWN_ALERTA_MS = 2000;  // intervalo minimo entre bipes do buzzer

// --- Estado mantido entre ciclos ---
unsigned long timestampUltimoEvento = 0;
unsigned long timestampUltimoAlerta = 0;
uint32_t seqLeitura = 0;
uint32_t seqHeartbeat = 0;
int ciclosConsecutivosSilencio = 0;
int ciclosConsecutivosAtivo = 0;
bool estadoSilencioso = false;

void setup() {
  Serial.begin(115200);
  dht.setup(PIN_DHT, DHTesp::DHT22);
  pinMode(PIN_BOTAO_SIMULA_DESCONEXAO, INPUT_PULLDOWN);
  pinMode(PIN_LED_STATUS, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_LED_STATUS, HIGH);
  timestampUltimoEvento = millis();
}

void loop() {
  bool desconectadoSimulado = digitalRead(PIN_BOTAO_SIMULA_DESCONEXAO) == HIGH;

  // O evento de leitura so e emitido quando o dispositivo "esta falando".
  if (!desconectadoSimulado) {
    int luxBruto = analogRead(PIN_LDR);
    float temperatura = dht.getTemperature();
    seqLeitura++;
    timestampUltimoEvento = millis();
    emitirLeituraAmbiente(luxBruto, temperatura);
  }

  // Ja a verificacao de heartbeat/silencio roda SEMPRE, independente do
  // botao - e o proprio gateway monitorando se ainda esta recebendo dados.
  avaliarSilencioEEmitirHeartbeat();

  delay(150); // ciclo de verificacao (nao confundir com o intervalo de emissao do evento)
}

void avaliarSilencioEEmitirHeartbeat() {
  unsigned long agora = millis();
  unsigned long silencioAtual = agora - timestampUltimoEvento;
  bool pareceSilencioso = silencioAtual > LIMIAR_SILENCIO_MS;

  // Debounce da TRANSICAO de estado: e o que evita que uma condicao
  // piscando rapido (ruido, ou o botao sendo apertado/solto repetidas
  // vezes no teste adversarial) faca o estado - e o alerta - oscilarem a
  // cada ciclo.
  if (pareceSilencioso) {
    ciclosConsecutivosSilencio++;
    ciclosConsecutivosAtivo = 0;
  } else {
    ciclosConsecutivosAtivo++;
    ciclosConsecutivosSilencio = 0;
  }

  if (!estadoSilencioso && ciclosConsecutivosSilencio >= CICLOS_DEBOUNCE) {
    estadoSilencioso = true;
    digitalWrite(PIN_LED_STATUS, LOW);
    dispararAlertaComCooldown();
  } else if (estadoSilencioso && ciclosConsecutivosAtivo >= CICLOS_DEBOUNCE) {
    estadoSilencioso = false;
    digitalWrite(PIN_LED_STATUS, HIGH);
  }

  seqHeartbeat++;
  Serial.print("{");
  Serial.print("\"eventType\":\"EstadoConectividade\",");
  Serial.print("\"deviceId\":\""); Serial.print(DEVICE_ID); Serial.print("\",");
  Serial.print("\"entityId\":\""); Serial.print(ENTITY_ID); Serial.print("\",");
  Serial.print("\"eventTimeMs\":"); Serial.print(agora); Serial.print(",");
  Serial.print("\"sequence\":"); Serial.print(seqHeartbeat); Serial.print(",");
  Serial.print("\"value\":"); Serial.print(silencioAtual); Serial.print(",");
  Serial.print("\"unit\":\"ms_desde_ultimo_evento\",");
  Serial.print("\"state\":\""); Serial.print(estadoSilencioso ? "SILENCIOSO" : "ATIVO"); Serial.print("\"");
  Serial.println("}");
}

void dispararAlertaComCooldown() {
  unsigned long agora = millis();
  if (agora - timestampUltimoAlerta >= COOLDOWN_ALERTA_MS) {
    tone(PIN_BUZZER, 1000, 200);
    timestampUltimoAlerta = agora;
  }
  // Se estiver dentro do cooldown, a transicao de estado ainda e registrada
  // e logada, mas o alerta sonoro nao "acumula" - e isso que impede o
  // acionamento repetido quando a condicao pisca rapido.
}

void emitirLeituraAmbiente(int luxBruto, float temperatura) {
  bool leituraDhtValida = !isnan(temperatura);
  Serial.print("{");
  Serial.print("\"eventType\":\"LeituraAmbiente\",");
  Serial.print("\"deviceId\":\""); Serial.print(DEVICE_ID); Serial.print("\",");
  Serial.print("\"entityId\":\""); Serial.print(ENTITY_ID); Serial.print("\",");
  Serial.print("\"eventTimeMs\":"); Serial.print(millis()); Serial.print(",");
  Serial.print("\"sequence\":"); Serial.print(seqLeitura); Serial.print(",");
  Serial.print("\"value\":"); Serial.print(luxBruto); Serial.print(",");
  Serial.print("\"unit\":\"raw_adc\",");
  Serial.print("\"temperaturaC\":");
  if (leituraDhtValida) { Serial.print(temperatura, 1); } else { Serial.print("null"); }
  Serial.println("}");
}

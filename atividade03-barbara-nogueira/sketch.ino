#include <Arduino.h>
#include <string.h>
#include "controle.h"

// Bárbara Nogueira — 202004744 — Não dê nem água
// LED verde indica autorização lógica; não controla bomba real.
constexpr int PIN_UMIDADE = 34;
constexpr int PIN_AMOSTRAGEM = 23; // INPUT_PULLUP: LOW coleta; HIGH interrompe
constexpr int PIN_AUTORIZACAO = 18;
constexpr int PIN_FALHA = 19;
constexpr uint32_t AMOSTRAGEM_MS = 1000;
constexpr uint32_t STATUS_MS = 1000;
Controle controle;
uint32_t ultimaAmostragem = 0;
uint32_t ultimoStatus = 0;
uint32_t sequencia = 0;

void emitirEvento(const char* tipo, uint32_t tempoEvento, uint32_t agora,
                  bool qualidadeValida) {
  Serial.printf("{\"eventType\":\"%s\",\"deviceId\":\"esp32-barbara-01\","
                "\"entityId\":\"vaso-01\",\"eventTimeMs\":%lu,"
                "\"sequence\":%lu,\"value\":", tipo,
                (unsigned long)tempoEvento, (unsigned long)++sequencia);
  if (controle.possuiLeitura) Serial.printf("%.2f", controle.ultimoValor);
  else Serial.print("null");
  Serial.printf(",\"unit\":\"pct_simulado\",\"state\":\"%s\","
                "\"valid\":%s,\"actuatorAuthorized\":%s,\"ageMs\":",
                controle.nome(), qualidadeValida ? "true" : "false",
                controle.autorizado() ? "true" : "false");
  if (controle.possuiLeitura)
    Serial.print((unsigned long)uint32_t(agora - controle.ultimaLeituraMs));
  else Serial.print("null");
  if (strcmp(tipo, "leitura.invalida") == 0) Serial.print(",\"rejectedValue\":-1");
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_UMIDADE, INPUT);
  pinMode(PIN_AMOSTRAGEM, INPUT_PULLUP);
  pinMode(PIN_AUTORIZACAO, OUTPUT);
  pinMode(PIN_FALHA, OUTPUT);
  analogReadResolution(12);
  digitalWrite(PIN_AUTORIZACAO, LOW);
  digitalWrite(PIN_FALHA, HIGH);
  Serial.println("Amostragem: chave esquerda coleta; direita pausa. Entrada i injeta leitura invalida.");
  emitirEvento("estado.inicial", 0, millis(), false);
}

void loop() {
  uint32_t agora = millis();
  Controle::Estado anterior = controle.estado;
  bool coletou = false;
  bool invalido = false;
  // Expiração continua funcionando mesmo quando a chave pausa as leituras.
  controle.atualizar(agora);
  while (Serial.available()) {
    if (Serial.read() == 'i') {
      controle.receber(-1.0f, agora);
      invalido = true;
    }
  }
  if (!invalido && digitalRead(PIN_AMOSTRAGEM) == LOW &&
      uint32_t(agora - ultimaAmostragem) >= AMOSTRAGEM_MS) {
    ultimaAmostragem = agora;
    int bruto = analogRead(PIN_UMIDADE);
    float umidadeFicticia = 100.0f * bruto / 4095.0f;
    controle.receber(umidadeFicticia, agora);
    coletou = true;
  }
  digitalWrite(PIN_AUTORIZACAO, controle.autorizado() ? HIGH : LOW);
  digitalWrite(PIN_FALHA, controle.falha() ? HIGH : LOW);
  if (invalido) emitirEvento("leitura.invalida", agora, agora, false);
  else if (coletou) emitirEvento("umidade.leitura", agora, agora, true);
  if (anterior != controle.estado) {
    Serial.printf("[%lu] state=%s reason=%s authorization=%s\n",
                  (unsigned long)agora, controle.nome(),
                  controle.estado == Controle::DADO_OBSOLETO ? "validade_expirada" :
                  invalido ? "entrada_invalida" : "nova_leitura_valida",
                  controle.autorizado() ? "ON" : "OFF");
    emitirEvento("estado.alterado", agora, agora, !controle.falha());
  }
  if (uint32_t(agora - ultimoStatus) >= STATUS_MS) {
    ultimoStatus = agora;
    emitirEvento("dispositivo.status", agora, agora, !controle.falha());
  }
}

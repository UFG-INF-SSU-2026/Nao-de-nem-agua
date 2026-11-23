// reservatorios.h — nivel dos reservatorios de agua e de adubo (HC-SR04)
//
// Marco 4. Na borda fica o que e barato e protege o hardware:
//   - descarte de leitura sem eco ou fora de 2–400 cm;
//   - MEDIANA das ultimas 5 leituras (um eco espurio nao vira "tanque vazio");
//   - conversao para % pela geometria do tanque;
//   - nivel critico LOCAL, que bloqueia a bomba mesmo sem rede.
// Os estados OK/BAIXO/CRITICO com histerese e os alertas sao do servico.
#pragma once
#include <Arduino.h>

static const int   JANELA_NIVEL      = 5;
static const int   MIN_VALIDAS_NIVEL = 3;
static const float DIST_MIN_CM       = 2.0f;
static const float DIST_MAX_CM       = 400.0f;
static const unsigned long ECO_TIMEOUT_US = 30000;

class Reservatorio {
 public:
  Reservatorio(const char *nome, int trig, int echo, float alturaCm, float folgaCm)
    : nome_(nome), trig_(trig), echo_(echo), altura_(alturaCm), folga_(folgaCm) {}

  void begin() {
    pinMode(trig_, OUTPUT);
    digitalWrite(trig_, LOW);
    pinMode(echo_, INPUT);
  }

  const char *nome() const { return nome_; }
  bool conhecido() const { return n_ >= MIN_VALIDAS_NIVEL; }
  float nivelPct() const { return nivel_; }
  float distanciaCm() const { return distancia_; }

  void amostrar() {
    digitalWrite(trig_, LOW);
    delayMicroseconds(2);
    digitalWrite(trig_, HIGH);
    delayMicroseconds(10);
    digitalWrite(trig_, LOW);
    unsigned long us = pulseIn(echo_, HIGH, ECO_TIMEOUT_US);
    if (us == 0) return; // sem eco
    float d = us / 58.0f;
    if (d < DIST_MIN_CM || d > DIST_MAX_CM) return;

    janela_[idx_] = d;
    idx_ = (idx_ + 1) % JANELA_NIVEL;
    if (n_ < JANELA_NIVEL) n_++;
    if (n_ < MIN_VALIDAS_NIVEL) return;

    distancia_ = mediana();
    float coluna = altura_ - (distancia_ - folga_);
    nivel_ = constrain(coluna / altura_ * 100.0f, 0.0f, 100.0f);
  }

 private:
  float mediana() const {
    float v[JANELA_NIVEL];
    for (int i = 0; i < n_; i++) v[i] = janela_[i];
    for (int i = 1; i < n_; i++) {
      float x = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
      v[j + 1] = x;
    }
    return (n_ % 2) ? v[n_ / 2] : (v[n_ / 2 - 1] + v[n_ / 2]) / 2.0f;
  }

  const char *nome_;
  int trig_, echo_;
  float altura_, folga_;
  float janela_[JANELA_NIVEL] = {0};
  int n_ = 0, idx_ = 0;
  float distancia_ = 0.0f;
  float nivel_ = 0.0f;
};

// sonda_solo.h — leitura da sonda de solo SIMULADA (custom chip "sonda-solo")
//
// Marco 4. Substitui o potenciometro do Marco 3. A sonda NAO e um sensor real:
// e um Custom Chip do Wokwi cujos valores verdadeiros vem dos sliders.
//
// O dispositivo faz aqui o que a Atividade 02 (itens 10 e 11) reservou a borda:
// conversao, validacao local e diagnostico de falha do sensor. Estado temporal
// e decisao continuam no servico.
//
//   UMID : 2,8 V (0 %) -> 0,6 V (100 %)   (estilo capacitivo)
//   TEMP : 0,5 V (0 C) -> 2,5 V (50 C)
//   EC   : 0 V -> 3,0 V = 0 -> 4000 uS/cm (EC APARENTE)
//
// Compensacao (curva conhecida da sonda, a mesma do chip):
//   ec25 = ec_aparente / (1 + 0.02 (T - 25)) / clamp(umidade/60, 0, 1.5)
// A EC so representa nutrientes com a umidade entre 35 % e 75 %.
#pragma once
#include <Arduino.h>
#include <math.h>
#include <string.h>

static const int PIN_SOLO_UMID = 34;
static const int PIN_SOLO_TEMP = 35;
static const int PIN_SOLO_EC   = 32;

static const float SOLO_V_ADC_MAX     = 3.3f;
static const float V_UMID_SECO        = 2.8f;
static const float V_UMID_ENCHARCADO  = 0.6f;
static const float V_TEMP_MIN         = 0.5f;
static const float V_TEMP_MAX         = 2.5f;
static const float TEMP_SOLO_MAX_C    = 50.0f;
static const float EC_FUNDO_ESCALA    = 4000.0f;
static const float V_EC_MAX           = 3.0f;
static const float COEF_TEMP_EC       = 0.02f;

static const float V_DESCONECTADA     = 0.3f;
static const float MARGEM_FAIXA_V     = 0.1f;
static const float UMID_MIN_VALIDA_EC = 35.0f;
static const float UMID_MAX_VALIDA_EC = 75.0f;

struct LeituraSolo {
  float vUmid, vTemp, vEc;
  float umidadePct;     // sempre em 0..100 (o contrato exige)
  float temperaturaC;
  float ecAparente;
  float ec25;
  bool  valida;
  bool  ecValida;
  const char *motivoInvalido;
  const char *motivoEcInvalida;
};

inline float lerTensaoMedia(int pino) {
  long soma = 0;
  for (int i = 0; i < 8; i++) soma += analogRead(pino);
  return (soma / 8.0f) * SOLO_V_ADC_MAX / 4095.0f;
}

inline LeituraSolo lerSondaSolo() {
  LeituraSolo l;
  l.vUmid = lerTensaoMedia(PIN_SOLO_UMID);
  l.vTemp = lerTensaoMedia(PIN_SOLO_TEMP);
  l.vEc   = lerTensaoMedia(PIN_SOLO_EC);
  l.valida = true;
  l.ecValida = true;
  l.ec25 = 0.0f;
  l.motivoInvalido = "";
  l.motivoEcInvalida = "";

  float umid = (V_UMID_SECO - l.vUmid) / (V_UMID_SECO - V_UMID_ENCHARCADO) * 100.0f;
  l.umidadePct   = constrain(umid, 0.0f, 100.0f);
  l.temperaturaC = constrain((l.vTemp - V_TEMP_MIN) / (V_TEMP_MAX - V_TEMP_MIN) * TEMP_SOLO_MAX_C, 0.0f, TEMP_SOLO_MAX_C);
  l.ecAparente   = constrain(l.vEc / V_EC_MAX * EC_FUNDO_ESCALA, 0.0f, 5000.0f);

  if (l.vUmid < V_DESCONECTADA) {
    l.valida = false; l.ecValida = false;
    l.motivoInvalido = "sonda_desconectada";
    l.motivoEcInvalida = "sonda_desconectada";
    return l;
  }
  if (l.vUmid > V_UMID_SECO + MARGEM_FAIXA_V || l.vUmid < V_UMID_ENCHARCADO - MARGEM_FAIXA_V ||
      l.vTemp > V_TEMP_MAX + MARGEM_FAIXA_V  || l.vTemp < V_TEMP_MIN - MARGEM_FAIXA_V) {
    l.valida = false; l.ecValida = false;
    l.motivoInvalido = "fora_da_faixa";
    l.motivoEcInvalida = "fora_da_faixa";
    return l;
  }

  float fatorTemp    = 1.0f + COEF_TEMP_EC * (l.temperaturaC - 25.0f);
  float fatorUmidade = constrain(l.umidadePct / 60.0f, 0.0f, 1.5f);
  l.ec25 = (fatorUmidade > 0.0f) ? l.ecAparente / fatorTemp / fatorUmidade : 0.0f;
  if (l.umidadePct < UMID_MIN_VALIDA_EC || l.umidadePct > UMID_MAX_VALIDA_EC) {
    l.ecValida = false;
    l.motivoEcInvalida = "umidade_fora_faixa_ec";
  }
  return l;
}

// ---------- Diagnostico de falha da sonda (validacao local) ----------
// - desconectada / fora de faixa: 3 leituras invalidas seguidas;
// - travada: desvio padrao da tensao de umidade < 1 mV nas ultimas 10 leituras
//   (sensor vivo sempre varia um pouco; a sonda "oxidada" congela);
// - ruidosa: 3+ REVERSOES (salto > 1,5 pt seguido de salto > 1,5 pt no sentido
//   contrario) nas ultimas 10 leituras. Mudanca real anda num sentido so.
//   Limiares escolhidos por simulacao: 0 falsos positivos com ruido natural.
static const int   JANELA_DIAG_SOLO      = 10;
static const float DESVIO_TRAVADA_V      = 0.001f;
static const float SALTO_RUIDO_PCT       = 1.5f;
static const int   REVERSOES_PARA_RUIDO  = 3;
static const int   INVALIDAS_PARA_FALHA  = 3;

enum FalhaSonda { SONDA_OK = 0, SONDA_DESCONECTADA, SONDA_FORA_FAIXA, SONDA_TRAVADA, SONDA_RUIDOSA };
static const char *NOMES_FALHA_SONDA[] = {"ok", "sonda_desconectada", "sonda_fora_da_faixa", "sonda_travada", "sonda_ruidosa"};

class MonitorSonda {
 public:
  bool emFalha() const { return falha_ != SONDA_OK; }
  const char *motivo() const { return NOMES_FALHA_SONDA[falha_]; }

  void registrar(const LeituraSolo &l) {
    if (!l.valida) {
      if (++invalidas_ >= INVALIDAS_PARA_FALHA)
        mudar(strcmp(l.motivoInvalido, "sonda_desconectada") == 0 ? SONDA_DESCONECTADA : SONDA_FORA_FAIXA);
      return;
    }
    invalidas_ = 0;
    v_[idx_] = l.vUmid;
    u_[idx_] = l.umidadePct;
    idx_ = (idx_ + 1) % JANELA_DIAG_SOLO;
    if (n_ < JANELA_DIAG_SOLO) n_++;

    FalhaSonda f = SONDA_OK;
    if (n_ == JANELA_DIAG_SOLO) {
      int rev = reversoes();
      if (desvio() < DESVIO_TRAVADA_V) f = SONDA_TRAVADA;
      else if (rev >= REVERSOES_PARA_RUIDO) f = SONDA_RUIDOSA;
      else if (falha_ == SONDA_RUIDOSA && rev > 0) f = SONDA_RUIDOSA; // histerese
    }
    mudar(f);
  }

 private:
  void mudar(FalhaSonda f) {
    if (f == falha_) return;
    falha_ = f;
    Serial.printf("   sonda de solo: %s\n", NOMES_FALHA_SONDA[f]);
  }
  float desvio() const {
    float m = 0;
    for (int i = 0; i < n_; i++) m += v_[i];
    m /= n_;
    float var = 0;
    for (int i = 0; i < n_; i++) var += (v_[i] - m) * (v_[i] - m);
    return sqrtf(var / n_);
  }
  int reversoes() const {
    int r = 0;
    float anterior = 0;
    for (int k = 1; k < n_; k++) {
      float salto = u_[(idx_ + k) % JANELA_DIAG_SOLO] - u_[(idx_ + k - 1) % JANELA_DIAG_SOLO];
      if (fabsf(salto) > SALTO_RUIDO_PCT && fabsf(anterior) > SALTO_RUIDO_PCT && salto * anterior < 0) r++;
      anterior = salto;
    }
    return r;
  }
  FalhaSonda falha_ = SONDA_OK;
  int invalidas_ = 0;
  float v_[JANELA_DIAG_SOLO] = {0};
  float u_[JANELA_DIAG_SOLO] = {0};
  int n_ = 0, idx_ = 0;
};

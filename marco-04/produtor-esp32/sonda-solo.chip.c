// Sonda de Solo 3-em-1 (SIMULADA) — Custom Chip do Wokwi
// Projeto "Nao de nem agua" — Marco 04
//
// Emula uma sonda comercial de substrato que mede umidade, temperatura e
// condutividade eletrica (EC, indicador de nutrientes). NAO e um sensor real:
// os valores "verdadeiros" vem dos sliders da simulacao.
//
// Saidas analogicas (0 a 3,3 V):
//   UMID : 2,8 V (solo seco, 0 %) -> 0,6 V (solo encharcado, 100 %)  [estilo capacitivo]
//   TEMP : 0,5 V (0 C) -> 2,5 V (50 C)
//   EC   : 0 V (0 uS/cm) -> 3,0 V (4000 uS/cm), EC APARENTE (ver modelo abaixo)
//
// Modelo fisico da EC aparente (o que um sensor real "enxerga"):
//   fator_umidade = clamp(umidade / 60, 0, 1.5)   pouca agua no poro conduz menos
//   fator_temp    = 1 + 0.02 * (temperatura - 25)  EC sobe ~2 %/C
//   ec_aparente   = ec25 * fator_umidade * fator_temp
//
// Falhas injetaveis (slider "falha"):
//   0 = ok           : apenas ruido natural pequeno (+/-0,5 %), como num sensor real
//   1 = desconectada : todas as saidas em 0 V
//   2 = oxidada      : UMID travada EXATAMENTE no ultimo valor (sem ruido nenhum)
//                      e EC com deriva crescente (+0,5 %/s)
//   3 = ruido        : +/-15 % de ruido aleatorio em cada saida
//
// O ruido natural existe para que o firmware consiga diferenciar um sensor
// vivo (sempre varia um pouco) de um sensor travado (valor identico).

#include "wokwi-api.h"
#include <stdint.h>
#include <stdlib.h>

#define PERIODO_US 100000 // atualiza as saidas a cada 100 ms

#define V_UMID_SECO 2.8f
#define V_UMID_ENCHARCADO 0.6f
#define V_TEMP_MIN 0.5f
#define V_TEMP_MAX 2.5f
#define TEMP_MAX_C 50.0f
#define EC_FUNDO_ESCALA 4000.0f
#define V_EC_MAX 3.0f
#define V_ADC_MAX 3.3f

#define DERIVA_POR_SEGUNDO 0.005f // 0,5 %/s
#define AMPLITUDE_RUIDO 0.15f     // +/-15 % (falha 3)
#define AMPLITUDE_RUIDO_NATURAL 0.005f // +/-0,5 % (operacao normal)

enum { FALHA_OK = 0, FALHA_DESCONECTADA = 1, FALHA_OXIDADA = 2, FALHA_RUIDO = 3 };

typedef struct {
  pin_t pin_umid;
  pin_t pin_temp;
  pin_t pin_ec;

  uint32_t attr_umidade;
  uint32_t attr_temperatura;
  uint32_t attr_ec25;
  uint32_t attr_falha;

  int falha_anterior;
  float fator_deriva;  // multiplica a EC enquanto a sonda esta "oxidada"
  float v_umid_travada; // ultimo V_UMID antes de oxidar
  float v_umid_atual;
} chip_state_t;

static float limitar(float v, float minimo, float maximo) {
  if (v < minimo) return minimo;
  if (v > maximo) return maximo;
  return v;
}

// Ruido uniforme em [-amplitude, +amplitude]
static float ruido_relativo(float amplitude) {
  float r = (float)rand() / (float)RAND_MAX; // 0..1
  return (r * 2.0f - 1.0f) * amplitude;
}

static void atualizar_saidas(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;

  float umidade = limitar(attr_read_float(chip->attr_umidade), 0.0f, 100.0f);
  float temperatura = limitar(attr_read_float(chip->attr_temperatura), 0.0f, TEMP_MAX_C);
  float ec25 = limitar(attr_read_float(chip->attr_ec25), 0.0f, EC_FUNDO_ESCALA);
  int falha = (int)(attr_read_float(chip->attr_falha) + 0.5f);

  // Ao entrar ou sair de uma falha, reinicia o estado dela
  if (falha != chip->falha_anterior) {
    chip->fator_deriva = 1.0f;
    chip->v_umid_travada = chip->v_umid_atual;
    chip->falha_anterior = falha;
  }

  // --- Modelo fisico ---
  float fator_umidade = limitar(umidade / 60.0f, 0.0f, 1.5f);
  float fator_temp = 1.0f + 0.02f * (temperatura - 25.0f);
  float ec_aparente = ec25 * fator_umidade * fator_temp;

  float v_umid = V_UMID_SECO - (umidade / 100.0f) * (V_UMID_SECO - V_UMID_ENCHARCADO);
  float v_temp = V_TEMP_MIN + (temperatura / TEMP_MAX_C) * (V_TEMP_MAX - V_TEMP_MIN);
  float v_ec = (ec_aparente / EC_FUNDO_ESCALA) * V_EC_MAX;

  chip->v_umid_atual = v_umid;

  // --- Falhas ---
  switch (falha) {
    case FALHA_DESCONECTADA:
      v_umid = 0.0f;
      v_temp = 0.0f;
      v_ec = 0.0f;
      break;

    case FALHA_OXIDADA:
      chip->fator_deriva += DERIVA_POR_SEGUNDO * (PERIODO_US / 1000000.0f);
      v_umid = chip->v_umid_travada; // travada: sem ruido
      v_temp *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO_NATURAL);
      v_ec *= chip->fator_deriva * (1.0f + ruido_relativo(AMPLITUDE_RUIDO_NATURAL));
      break;

    case FALHA_RUIDO:
      v_umid *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO);
      v_temp *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO);
      v_ec *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO);
      break;

    default: // FALHA_OK
      v_umid *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO_NATURAL);
      v_temp *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO_NATURAL);
      v_ec *= 1.0f + ruido_relativo(AMPLITUDE_RUIDO_NATURAL);
      break;
  }

  pin_dac_write(chip->pin_umid, limitar(v_umid, 0.0f, V_ADC_MAX));
  pin_dac_write(chip->pin_temp, limitar(v_temp, 0.0f, V_ADC_MAX));
  pin_dac_write(chip->pin_ec, limitar(v_ec, 0.0f, V_ADC_MAX));
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));

  chip->pin_umid = pin_init("UMID", ANALOG);
  chip->pin_temp = pin_init("TEMP", ANALOG);
  chip->pin_ec = pin_init("EC", ANALOG);

  // Valores iniciais (podem ser sobrescritos em "attrs" no diagram.json)
  chip->attr_umidade = attr_init_float("umidade", 50.0f);
  chip->attr_temperatura = attr_init_float("temperatura", 25.0f);
  chip->attr_ec25 = attr_init_float("ec25", 1200.0f);
  chip->attr_falha = attr_init_float("falha", 0.0f);

  chip->falha_anterior = FALHA_OK;
  chip->fator_deriva = 1.0f;
  chip->v_umid_atual = V_UMID_SECO;
  chip->v_umid_travada = V_UMID_SECO;

  srand(42);
  atualizar_saidas(chip);

  const timer_config_t config = {
    .callback = atualizar_saidas,
    .user_data = chip,
  };
  timer_t timer = timer_init(&config);
  timer_start(timer, PERIODO_US, true);
}

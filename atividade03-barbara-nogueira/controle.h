#pragma once
#include <stdint.h>
#include <math.h>

// Tempos reduzidos para observar o comportamento na simulação.
struct Controle {
  enum Estado { DESCONHECIDO, NORMAL, AGUARDANDO, AUTORIZADO,
                DADO_OBSOLETO, LEITURA_INVALIDA };
  static constexpr uint32_t VALIDADE_MS = 5000;
  static constexpr float LIMIAR_SECO = 30.0f;
  static constexpr unsigned MIN_AMOSTRAS = 3;
  Estado estado = DESCONHECIDO;
  bool possuiLeitura = false;
  bool ultimaEntradaValida = false;
  float ultimoValor = 0;
  uint32_t ultimaLeituraMs = 0;
  unsigned consecutivasSecas = 0;

  void receber(float valor, uint32_t agora) {
    if (!isfinite(valor) || valor < 0 || valor > 100) {
      ultimaEntradaValida = false;
      consecutivasSecas = 0;
      estado = LEITURA_INVALIDA;
      return; // último valor válido fica armazenado, mas não autoriza saída
    }
    if (!ultimaEntradaValida || !possuiLeitura ||
        uint32_t(agora - ultimaLeituraMs) >= VALIDADE_MS) {
      consecutivasSecas = 0;
    }
    possuiLeitura = true;
    ultimaEntradaValida = true;
    ultimoValor = valor;
    ultimaLeituraMs = agora;
    if (valor < LIMIAR_SECO) {
      if (consecutivasSecas < MIN_AMOSTRAS) ++consecutivasSecas;
      estado = consecutivasSecas >= MIN_AMOSTRAS ? AUTORIZADO : AGUARDANDO;
    } else {
      consecutivasSecas = 0;
      estado = NORMAL;
    }
  }

  void atualizar(uint32_t agora) {
    if (!possuiLeitura || !ultimaEntradaValida) return;
    if (uint32_t(agora - ultimaLeituraMs) >= VALIDADE_MS) {
      estado = DADO_OBSOLETO;
      consecutivasSecas = 0;
    }
  }
  bool autorizado() const { return estado == AUTORIZADO; }
  bool falha() const {
    return estado == DESCONHECIDO || estado == DADO_OBSOLETO ||
           estado == LEITURA_INVALIDA;
  }
  const char* nome() const {
    switch (estado) {
      case NORMAL: return "NORMAL";
      case AGUARDANDO: return "AGUARDANDO";
      case AUTORIZADO: return "AUTORIZADO";
      case DADO_OBSOLETO: return "DADO_OBSOLETO";
      case LEITURA_INVALIDA: return "LEITURA_INVALIDA";
      default: return "DESCONHECIDO";
    }
  }
};

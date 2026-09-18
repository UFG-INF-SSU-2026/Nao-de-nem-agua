/*
 * Atividade 03 - Software para Sistemas Ubiquos
 * Projeto: Nao de nem agua
 * Recorte individual: irrigacao com histerese
 * Perfil: Decisao e atuacao
 *
 * Entrada: potenciometro no GPIO 34, simulando umidade do solo (0 a 100%).
 * Saida: LED no GPIO 23, simulando a bomba de irrigacao.
 *
 * Regra:
 *   - liga a bomba em umidade <= 25%;
 *   - desliga a bomba em umidade >= 35%;
 *   - entre os dois limiares, mantem o estado anterior;
 *   - se a leitura variar excessivamente durante uma amostragem,
 *     considera a entrada instavel e desliga a atuacao por seguranca.
 */

const int PINO_UMIDADE = 34;
const int PINO_BOMBA = 23;

const float LIMIAR_LIGAR = 25.0;
const float LIMIAR_DESLIGAR = 35.0;

const int QUANTIDADE_AMOSTRAS = 7;
const int INTERVALO_AMOSTRAS_MS = 8;
const int VARIACAO_MAXIMA_ADC = 350;
const unsigned long INTERVALO_EVENTO_MS = 1000;

bool bombaLigada = false;
unsigned long sequencia = 0;
unsigned long ultimoEventoMs = 0;

struct LeituraUmidade {
  int adcMedio;
  int variacaoAdc;
  float percentual;
  bool estavel;
};

LeituraUmidade lerUmidade() {
  long soma = 0;
  int minimo = 4095;
  int maximo = 0;

  for (int i = 0; i < QUANTIDADE_AMOSTRAS; i++) {
    int valor = analogRead(PINO_UMIDADE);
    soma += valor;

    if (valor < minimo) minimo = valor;
    if (valor > maximo) maximo = valor;

    delay(INTERVALO_AMOSTRAS_MS);
  }

  LeituraUmidade leitura;
  leitura.adcMedio = soma / QUANTIDADE_AMOSTRAS;
  leitura.variacaoAdc = maximo - minimo;
  leitura.percentual = (leitura.adcMedio / 4095.0) * 100.0;
  leitura.estavel = leitura.variacaoAdc <= VARIACAO_MAXIMA_ADC;
  return leitura;
}

const char* aplicarRegra(const LeituraUmidade& leitura) {
  // Falha segura: entrada instavel nao pode manter uma atuacao automatica.
  if (!leitura.estavel) {
    bombaLigada = false;
    digitalWrite(PINO_BOMBA, LOW);
    return "ENTRADA_INSTAVEL";
  }

  if (!bombaLigada && leitura.percentual <= LIMIAR_LIGAR) {
    bombaLigada = true;
    digitalWrite(PINO_BOMBA, HIGH);
  } else if (bombaLigada && leitura.percentual >= LIMIAR_DESLIGAR) {
    bombaLigada = false;
    digitalWrite(PINO_BOMBA, LOW);
  }

  if (bombaLigada) return "IRRIGANDO";
  if (leitura.percentual < LIMIAR_DESLIGAR) return "FAIXA_HISTERESE";
  return "NORMAL";
}

void emitirEvento(const LeituraUmidade& leitura, const char* estado) {
  sequencia++;

  Serial.print("{");
  Serial.print("\"eventType\":\"LeituraUmidadeSolo\",");
  Serial.print("\"deviceId\":\"esp32-vaso-01\",");
  Serial.print("\"entityId\":\"vaso-01\",");
  Serial.print("\"eventTimeMs\":");
  Serial.print(millis());
  Serial.print(",\"sequence\":");
  Serial.print(sequencia);
  Serial.print(",\"value\":");
  Serial.print(leitura.percentual, 1);
  Serial.print(",\"unit\":\"%\",");
  Serial.print("\"state\":\"");
  Serial.print(estado);
  Serial.print("\",\"actuator\":\"");
  Serial.print(bombaLigada ? "BOMBA_LIGADA" : "BOMBA_DESLIGADA");
  Serial.print("\",\"adcRaw\":");
  Serial.print(leitura.adcMedio);
  Serial.print(",\"adcSpread\":");
  Serial.print(leitura.variacaoAdc);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  pinMode(PINO_UMIDADE, INPUT);
  pinMode(PINO_BOMBA, OUTPUT);
  digitalWrite(PINO_BOMBA, LOW);

  analogReadResolution(12);
  delay(500);

  Serial.println("Sistema iniciado: irrigacao com histerese.");
  Serial.println("Ligar <= 25%; desligar >= 35%; entre os limiares, manter estado.");
}

void loop() {
  unsigned long agora = millis();
  if (agora - ultimoEventoMs < INTERVALO_EVENTO_MS) return;
  ultimoEventoMs = agora;

  LeituraUmidade leitura = lerUmidade();
  const char* estado = aplicarRegra(leitura);
  emitirEvento(leitura, estado);
}

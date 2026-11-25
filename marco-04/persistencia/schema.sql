-- Marco 4 -- esquema do servico-irrigacao no TimescaleDB.
--
-- Migracao IDEMPOTENTE: o servico executa este arquivo inteiro a cada partida
-- (e `npm run banco:migrar` tambem). Tudo e IF NOT EXISTS / if_not_exists.
-- Cada comando termina em ponto e virgula no fim da linha: e assim que
-- persistencia/index.js separa os comandos (CREATE MATERIALIZED VIEW ... WITH
-- (timescaledb.continuous) nao pode rodar dentro de uma transacao).
--
-- TEMPO. A coluna `ts` de toda hypertable e o relogio do SERVICO no instante em
-- que o dado foi aceito -- mesma escolha de consumidor-servico/src/estado.js: o
-- dispositivo nao tem NTP e seu eventTimeMs e relativo ao boot. O tempo do
-- dispositivo fica guardado (event_time_ms + boot_id) para reconstruir a ordem
-- dentro de um boot.
--
-- IDEMPOTENCIA. Cada linha recebe um `id` (uuid) no instante em que e
-- enfileirada; a chave primaria e (id, ts) -- hypertable exige a coluna de
-- tempo em toda chave unica. Um reenvio da mesma linha pela fila (banco caiu
-- no meio do INSERT) cai no ON CONFLICT DO NOTHING. A deduplicacao de eventos
-- por eventId continua sendo do servico (estado.js), antes de gravar.

SET search_path TO naodenemagua, public;

-- ---------------------------------------------------------------------------
-- Cadastro: especies, grupos, vasos e fotos (tabelas comuns)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS especies (
  id              text PRIMARY KEY,
  nome_popular    text NOT NULL,
  nome_cientifico text,
  observacoes     text,
  -- Perfil de cuidado PARCIAL (so o que difere do config.json); validado por
  -- contrato/v1/perfil-cuidado.schema.json antes de ser aplicado.
  parametros      jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grupos (
  id            text PRIMARY KEY,
  nome          text NOT NULL,
  descricao     text,
  parametros    jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vasos (
  vaso_id       text PRIMARY KEY,
  nome          text NOT NULL,
  especie_id    text REFERENCES especies(id),
  grupo_id      text REFERENCES grupos(id),
  device_id     text,
  localizacao   text,
  plantado_em   date,
  ativo         boolean NOT NULL DEFAULT true,
  parametros    jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Fotos: so os METADADOS. O arquivo fica fora do banco (volume/disco) e o
-- upload chega com o aplicativo.
CREATE TABLE IF NOT EXISTS fotos (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vaso_id   text NOT NULL REFERENCES vasos(vaso_id) ON DELETE CASCADE,
  arquivo   text NOT NULL,
  tirada_em timestamptz NOT NULL DEFAULT now(),
  legenda   text
);

-- ---------------------------------------------------------------------------
-- Estado das regras (snapshot restaurado na partida)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS estado_servico (
  chave         text PRIMARY KEY,
  valor         jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Historico: hypertables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telemetria_solo (
  id                uuid NOT NULL,
  ts                timestamptz NOT NULL,
  vaso_id           text NOT NULL,
  device_id         text NOT NULL,
  boot_id           text,
  event_id          text NOT NULL,
  sequence          integer,
  event_time_ms     bigint,
  umidade_pct       real,
  valida            boolean NOT NULL,
  motivo_invalido   text,
  solo_temp_c       real,
  ec_aparente_us_cm real,
  ec25_us_cm        real,
  ec_valida         boolean,
  replayed          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('telemetria_solo', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetria_solo_vaso_ts ON telemetria_solo (vaso_id, ts DESC);
CREATE INDEX IF NOT EXISTS telemetria_solo_event ON telemetria_solo (event_id);

CREATE TABLE IF NOT EXISTS telemetria_ambiente (
  id              uuid NOT NULL,
  ts              timestamptz NOT NULL,
  vaso_id         text NOT NULL,
  device_id       text NOT NULL,
  boot_id         text,
  event_id        text NOT NULL,
  sequence        integer,
  event_time_ms   bigint,
  umidade_ar_pct  real,
  temperatura_c   real,
  valida          boolean NOT NULL,
  motivo_invalido text,
  replayed        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('telemetria_ambiente', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetria_ambiente_vaso_ts ON telemetria_ambiente (vaso_id, ts DESC);

-- Marco 4: luz medida pelo sensor do CELULAR (o app como produtor; regra R5).
-- ts = quando o servico aceitou; measured_at = fim da janela no relogio do
-- celular. atrasada = chegou fora da validade (arquivada, nao decidiu).
CREATE TABLE IF NOT EXISTS telemetria_luz (
  id              uuid NOT NULL,
  ts              timestamptz NOT NULL,
  vaso_id         text NOT NULL,
  device_id       text NOT NULL,
  event_id        text NOT NULL,
  sequence        integer,
  measured_at     timestamptz NOT NULL,
  lux             real,
  amostras        integer,
  valida          boolean NOT NULL,
  motivo_invalido text,
  atrasada        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('telemetria_luz', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetria_luz_vaso_ts ON telemetria_luz (vaso_id, ts DESC);

CREATE TABLE IF NOT EXISTS telemetria_reservatorio (
  id              uuid NOT NULL,
  ts              timestamptz NOT NULL,
  vaso_id         text NOT NULL,
  device_id       text NOT NULL,
  boot_id         text,
  event_id        text NOT NULL,
  sequence        integer,
  event_time_ms   bigint,
  reservatorio    text NOT NULL,
  nivel_pct       real,
  distancia_cm    real,
  valida          boolean NOT NULL,
  motivo_invalido text,
  replayed        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('telemetria_reservatorio', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS telemetria_reservatorio_vaso_ts ON telemetria_reservatorio (vaso_id, reservatorio, ts DESC);

-- Comandos emitidos pelo servico (irrigacao e atuadores).
CREATE TABLE IF NOT EXISTS comandos (
  id             uuid NOT NULL,
  ts             timestamptz NOT NULL,
  vaso_id        text NOT NULL,
  command_id     text NOT NULL,
  tipo           text NOT NULL,
  atuador        text NOT NULL,
  acao           text NOT NULL,
  motivo         text,
  correlation_id text,
  duracao_ms     integer,
  device_id      text,
  payload        jsonb NOT NULL,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('comandos', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS comandos_command ON comandos (command_id);

-- Confirmacoes de negocio (acks) recebidas do dispositivo.
CREATE TABLE IF NOT EXISTS confirmacoes (
  id             uuid NOT NULL,
  ts             timestamptz NOT NULL,
  vaso_id        text NOT NULL,
  command_id     text NOT NULL,
  device_id      text,
  correlation_id text,
  resultado      text NOT NULL,
  detalhe        text,
  topico         text NOT NULL,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('confirmacoes', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS confirmacoes_command ON confirmacoes (command_id);

-- Alertas publicados em alert/cuidado.
CREATE TABLE IF NOT EXISTS alertas (
  id             uuid NOT NULL,
  ts             timestamptz NOT NULL,
  vaso_id        text NOT NULL,
  event_id       text NOT NULL,
  tipo           text NOT NULL,
  severidade     text NOT NULL,
  mensagem       text NOT NULL,
  correlation_id text,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('alertas', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS alertas_vaso_ts ON alertas (vaso_id, ts DESC);

-- Transicoes de estado das regras (solo, ar, reservatorios, adubacao,
-- verificacao, perfil, persistencia): a "explicacao" do historico.
CREATE TABLE IF NOT EXISTS transicoes (
  id         uuid NOT NULL,
  ts         timestamptz NOT NULL,
  vaso_id    text NOT NULL,
  componente text NOT NULL,
  anterior   text,
  atual      text NOT NULL,
  motivo     text,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('transicoes', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS transicoes_vaso_ts ON transicoes (vaso_id, componente, ts DESC);

-- ---------------------------------------------------------------------------
-- Agregados continuos (series por minuto, para o app e para o artigo)
-- ---------------------------------------------------------------------------

-- So leituras validas e do presente (replayed fica fora: e historico atrasado).
CREATE MATERIALIZED VIEW IF NOT EXISTS solo_1min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       vaso_id,
       avg(umidade_pct)  AS umidade_media,
       min(umidade_pct)  AS umidade_min,
       max(umidade_pct)  AS umidade_max,
       avg(ec25_us_cm)   AS ec25_media,
       avg(solo_temp_c)  AS solo_temp_media,
       count(*)          AS amostras
FROM telemetria_solo
WHERE valida AND NOT replayed
GROUP BY bucket, vaso_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('solo_1min',
  start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS ambiente_1min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       vaso_id,
       avg(umidade_ar_pct) AS umidade_ar_media,
       avg(temperatura_c)  AS temperatura_media,
       count(*)            AS amostras
FROM telemetria_ambiente
WHERE valida AND NOT replayed
GROUP BY bucket, vaso_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('ambiente_1min',
  start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

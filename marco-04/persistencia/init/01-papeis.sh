#!/bin/bash
# Executado UMA vez pelo conteiner, na criacao do volume (docker-entrypoint-initdb.d).
#
# Menor privilegio:
#   postgres           administrador -- so para operacao (psql); nunca vai para o servico nem para o app
#   servico_irrigacao  dono do schema naodenemagua: cria as proprias tabelas (migracao) e grava
#   leitor_app         so SELECT -- e o papel que a API do aplicativo vai usar
#
# Dois bancos com a mesma estrutura: naodenemagua (execucao) e naodenemagua_teste
# (`npm run teste:persistencia`, que apaga os dados que cria).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE ROLE servico_irrigacao LOGIN PASSWORD '${PERSISTENCIA_SENHA_SERVICO}';
  CREATE ROLE leitor_app LOGIN PASSWORD '${PERSISTENCIA_SENHA_LEITOR}';
  CREATE DATABASE naodenemagua_teste;
EOSQL

for banco in naodenemagua naodenemagua_teste; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$banco" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    REVOKE ALL ON DATABASE ${banco} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${banco} TO servico_irrigacao, leitor_app;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE SCHEMA naodenemagua AUTHORIZATION servico_irrigacao;
    GRANT USAGE ON SCHEMA naodenemagua TO leitor_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE servico_irrigacao IN SCHEMA naodenemagua
      GRANT SELECT ON TABLES TO leitor_app;
EOSQL
done

-- Marco 4 -- cadastro inicial (`npm run banco:seed`). Idempotente: rodar de
-- novo restaura os valores abaixo.
--
-- Os perfis sao PARCIAIS: so o que difere do config.json. Os numeros sao de
-- demonstracao, coerentes com a escala simulada do projeto (umidade "pct_simulado"
-- e EC em uS/cm), nao uma recomendacao agronomica.

SET search_path TO naodenemagua, public;

INSERT INTO especies (id, nome_popular, nome_cientifico, observacoes, parametros) VALUES
  ('jiboia', 'Jiboia', 'Epipremnum aureum',
   'Tolerante; perfil igual ao padrao do config.json.',
   '{}'::jsonb),
  ('samambaia', 'Samambaia', 'Nephrolepis exaltata',
   'Gosta de solo sempre umido e ar umido.',
   '{"regra": {"limiarLiga": 45, "limiarDesliga": 65}, "ambiente": {"umidadeArMin": 60}}'::jsonb),
  ('suculenta', 'Suculenta (echeveria)', 'Echeveria elegans',
   'Rega espacada: so com o solo bem seco; dispensa umidificador; pouco adubo.',
   '{"regra": {"limiarLiga": 15, "limiarDesliga": 30, "duracaoPulsoMs": 2000}, "ambiente": {"umidadeArMin": 20}, "adubacao": {"ec25MinUsCm": 400, "ec25MaxUsCm": 1200}}'::jsonb),
  ('orquidea', 'Orquidea (phalaenopsis)', 'Phalaenopsis spp.',
   'Substrato arejado; pouco adubo e ar umido.',
   '{"regra": {"limiarLiga": 25, "limiarDesliga": 40}, "ambiente": {"umidadeArMin": 55}, "adubacao": {"ec25MinUsCm": 500, "ec25MaxUsCm": 1500}}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  nome_popular = EXCLUDED.nome_popular, nome_cientifico = EXCLUDED.nome_cientifico,
  observacoes = EXCLUDED.observacoes, parametros = EXCLUDED.parametros, atualizado_em = now();

INSERT INTO grupos (id, nome, descricao, parametros) VALUES
  ('sala', 'Sala (meia-sombra)', 'Ambiente interno, sem sol direto.', '{}'::jsonb),
  ('varanda-sol', 'Varanda com sol', 'Sol da tarde: o solo seca mais rapido, entao a irrigacao comeca um pouco antes.',
   '{"regra": {"cooldownMs": 6000}}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome, descricao = EXCLUDED.descricao, parametros = EXCLUDED.parametros, atualizado_em = now();

INSERT INTO vasos (vaso_id, nome, especie_id, grupo_id, device_id, localizacao, plantado_em, parametros) VALUES
  ('vaso-01', 'Jiboia da sala', 'jiboia', 'sala', 'sim-vaso-01', 'Sala, ao lado da janela', DATE '2026-08-15', '{}'::jsonb)
ON CONFLICT (vaso_id) DO UPDATE SET
  nome = EXCLUDED.nome, especie_id = EXCLUDED.especie_id, grupo_id = EXCLUDED.grupo_id,
  device_id = EXCLUDED.device_id, localizacao = EXCLUDED.localizacao,
  plantado_em = EXCLUDED.plantado_em, parametros = EXCLUDED.parametros, atualizado_em = now();

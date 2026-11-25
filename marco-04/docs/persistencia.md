# Persistência de dados — TimescaleDB

Item obrigatório do Marco 4: *armazenar e recuperar os dados relevantes do
sistema, preservando-os após o encerramento da aplicação; preferencialmente,
banco de dados temporal*. Até aqui todo o estado vivia na memória do
`servico-irrigacao` (limitação 6 do `marco-04.md`), e os limiares eram os
mesmos para qualquer planta (limitação 5). As duas foram resolvidas.

| O quê | Onde | Para quê |
|---|---|---|
| **Histórico** — telemetria (solo, ar, reservatórios e a **luz medida pelo celular**), comandos, acks, alertas, transições de estado | 8 **hypertables** (`telemetria_luz` entrou com o app — [aplicativo.md](aplicativo.md), §7) | app (gráficos e histórico), artigo (avaliação), auditoria da decisão |
| **Estado das regras** — doses na janela, bloqueios, deduplicação, contadores | `estado_servico` (snapshot) | o serviço reinicia **sem esquecer** o que protege a planta |
| **Cadastro** — espécies, grupos, vasos, fotos (metadados) | tabelas comuns | perfil de cuidado por espécie/grupo/vaso |

---

## 1. Por que TimescaleDB

- **É temporal** (o "preferencialmente" do PDF): hypertables particionadas por
  tempo, `time_bucket`, agregados contínuos e política de retenção.
- **É PostgreSQL**: o mesmo banco guarda série temporal *e* dado relacional
  (cadastro, snapshot em `jsonb`), com `JOIN` entre eles — "umidade média por
  espécie" é uma consulta só. Um banco só de séries (InfluxDB) obrigaria a um
  segundo armazenamento para o estado e o cadastro.
- **Papéis e permissões** do PostgreSQL dão menor privilégio sem código nosso.
- Custo: passa a exigir **Docker**. Mitigado: `PERSISTENCIA_HABILITADA=0` roda
  tudo em memória como antes, e `npm run teste` (95 verificações) não depende
  do banco.

## 2. Implantação

```powershell
npm run seguranca      # gera também o .env com as senhas do banco (fora do Git)
npm run banco          # docker compose up -d --wait timescaledb
npm run banco:seed     # cria o schema e o cadastro inicial (vaso-01 = jiboia)
```

| Item | Valor |
|---|---|
| Imagem | `timescale/timescaledb:2.17.2-pg16` (PostgreSQL 16, TimescaleDB 2.17.2) |
| Porta | `127.0.0.1:5432` — só na interface local (`PERSISTENCIA_PORTA` muda) |
| Volume | `naodenemagua-dados` — é ele que preserva os dados entre reinícios do contêiner |
| Bancos | `naodenemagua` (execução) e `naodenemagua_teste` (apagado pelo teste) |
| Schema | `naodenemagua`, migrado pelo serviço a cada partida (idempotente) |
| Configuração | seção `persistencia` do `config.json`, sobrescrevível por `PERSISTENCIA_*` |

Operação:

| Comando | Faz |
|---|---|
| `npm run banco:consultar` | resumo: cadastro, perfil efetivo, contagens, `solo_1min`, últimos alertas e comandos, snapshot |
| `npm run banco:consultar -- --especie samambaia` | troca a espécie do vaso (o serviço aplica em até 15 s) |
| `npm run banco:psql` | `psql` como administrador, para inspeção |
| `npm run banco:parar` | para o contêiner (os dados ficam no volume) |
| `docker compose down -v` | **apaga** o volume — e com ele todos os dados |

### Papéis (menor privilégio)

Criados por `persistencia/init/01-papeis.sh` na primeira subida do volume:

| Papel | Pode | Quem usa |
|---|---|---|
| `postgres` | tudo | só operação (`npm run banco:psql`); **nunca** vai para o serviço nem para o app |
| `servico_irrigacao` | dono do schema `naodenemagua`: cria as próprias tabelas, lê e grava | `servico-irrigacao` |
| `leitor_app` | **só `SELECT`** | usado pela API de histórico do app ([aplicativo.md](aplicativo.md), §8) |

As senhas são aleatórias, geradas por `npm run seguranca` no `.env` (ignorado
pelo Git; o modelo sem valores é `.env.exemplo`). `npm run seguranca -- --forcar`
**não** troca as senhas do banco: o volume já foi criado com elas.

## 3. Modelo de dados (`persistencia/schema.sql`)

### Tempo

A coluna `ts` de toda hypertable é o **relógio do serviço** no instante em que
o dado foi aceito — a mesma escolha do `estado.js`: o dispositivo não tem NTP e
o seu `eventTimeMs` é relativo ao boot. O tempo do dispositivo também é guardado
(`event_time_ms` + `boot_id`), o que permite reconstruir a ordem dentro de um
boot. Leituras `replayed` (buffer offline do dispositivo) **são gravadas** com
`replayed = true`: não decidem nada, mas são dado real do vaso.

### Hypertables

| Tabela | Uma linha por | Colunas principais |
|---|---|---|
| `telemetria_solo` | `LeituraUmidadeSolo` aceita | `umidade_pct`, `solo_temp_c`, `ec_aparente_us_cm`, `ec25_us_cm`, `ec_valida`, `valida`, `replayed` |
| `telemetria_ambiente` | `LeituraAmbiente` | `umidade_ar_pct`, `temperatura_c` |
| `telemetria_reservatorio` | `NivelReservatorio` | `reservatorio` (AGUA/ADUBO), `nivel_pct`, `distancia_cm` |
| `comandos` | comando emitido | `command_id`, `atuador`, `acao`, `motivo`, `correlation_id`, `payload` (jsonb) |
| `confirmacoes` | ack recebido | `command_id`, `resultado`, `detalhe` |
| `alertas` | `AlertaCuidado` publicado | `event_id`, `tipo`, `severidade`, `mensagem`, `correlation_id` |
| `transicoes` | mudança de estado de uma regra | `componente` (solo, ar, reservatorio_*, adubacao, verificacao, perfil, servico), `anterior`, `atual`, `motivo` |

A cadeia **leitura → transição → comando → ack → alerta** é reconstruível por
`event_id`, `correlation_id` e `command_id` — o mesmo encadeamento do
`eventos.jsonl`, agora consultável.

**Idempotência.** Cada linha recebe um `id` (uuid) quando é enfileirada; a
chave primária é `(id, ts)` (hypertable exige a coluna de tempo em toda chave
única) e o `INSERT` usa `ON CONFLICT DO NOTHING`. Um reenvio da fila não
duplica. A deduplicação por `eventId` continua sendo do serviço, *antes* de
gravar — e sobrevive ao reinício (§4).

### Recursos temporais

- **Agregados contínuos** `solo_1min` e `ambiente_1min` (`time_bucket` de 1
  min: média/mín/máx de umidade, EC média, temperatura, nº de amostras), só com
  leituras válidas e não `replayed`, atualizados a cada minuto e com
  *real-time aggregation* (incluem os minutos ainda não materializados).
- **Retenção**: a telemetria bruta é descartada após `retencaoDias` (30); os
  agregados, comandos, alertas e transições ficam.

```sql
-- umidade média por hora do vaso-01 nas últimas 24 h
SELECT time_bucket('1 hour', bucket) AS hora, avg(umidade_media)
  FROM naodenemagua.solo_1min
 WHERE vaso_id = 'vaso-01' AND bucket > now() - interval '24 hours'
 GROUP BY hora ORDER BY hora;

-- por que a bomba ligou? comando, leitura que o originou e o ack
SELECT c.ts, c.command_id, c.acao, c.motivo, s.umidade_pct, a.resultado
  FROM naodenemagua.comandos c
  LEFT JOIN naodenemagua.telemetria_solo s ON s.event_id = c.correlation_id
  LEFT JOIN naodenemagua.confirmacoes a   ON a.command_id = c.command_id
 ORDER BY c.ts DESC LIMIT 10;
```

### Cadastro

`especies`, `grupos`, `vasos` (com `especie_id`, `grupo_id`, `device_id`,
`localizacao`, `plantado_em`, `ativo`) e `fotos` (só metadados: o arquivo fica
fora do banco; o upload chega com o aplicativo). Cada um dos três primeiros tem
`parametros` (jsonb) — o **perfil de cuidado** (§5).

## 4. O que é restaurado no reinício — e o que não é

O serviço salva um snapshot (`estado_servico`, chave `vaso:<id>`) sempre que o
estado muda, no máximo a cada `intervaloSnapshotMs` (2 s), e ao encerrar. Na
partida, **antes de entrar no broker** (`manualConnect`), ele restaura:

| Regra | Restaurado | **Não** restaurado (de propósito) |
|---|---|---|
| Solo (`estado.js`) | últimos 500 `eventId` (dedup), `ultimoComandoEm` (cooldown), fim do pulso (intertravamento), último valor | a **autorização**: volta `DADO_OBSOLETO` (ou `DESCONHECIDO`) e a contagem de secas recomeça — validade é por tempo e o dado de antes do reinício não descreve o agora |
| Verificação do efeito (R2) | o **bloqueio** por bomba sem fluxo e o diagnóstico | verificação em curso: as leituras do intervalo fora se perderam; julgar sem elas daria diagnóstico falso |
| Adubação (R3) | **doses na janela**, cooldown de tentativa, estado `BLOQUEADA`, aviso de excesso | estados transitórios (medindo, aguardando) → `OCIOSO`; médias de EC |
| Umidificador (R1) | instante da última troca (tempo mínimo do relé) | ligado: volta desligado — a concessão vence sozinha no dispositivo |
| Reservatórios (R4) | — | tudo: o dado vence em 10 s |
| Contadores `cmd-`/`atu-` | sim | — |

Três decisões merecem destaque:

1. **Dose em curso no reinício conta como aplicada.** Se o snapshot diz
   `DOSANDO` com comando publicado, a dose entra no limite. É a mesma suposição
   segura do ack perdido (Marco 3): diante do silêncio, um efeito físico é
   assumido como ocorrido.
2. **Contador de comandos continua.** O dispositivo guarda as `idempotencyKey`
   já aplicadas; um serviço que recomeçasse em `cmd-000001` teria o primeiro
   comando recusado como `IGNORADO_DUPLICADO`.
3. **Reiniciar não é um jeito de burlar proteção.** Limite de doses e bloqueio
   por falha sobrevivem — sem isso, derrubar o serviço religaria uma bomba que
   não bombeia ou daria uma segunda dose de adubo.

### Banco fora do ar

O banco **não é caminho crítico da decisão**. `gravar()` só enfileira; um
despejo assíncrono escreve:

- **Queda com o serviço rodando:** o serviço continua medindo, decidindo e
  comandando. As gravações ficam na fila (até `filaMax` = 10 000; depois
  descarta as **mais antigas** e conta). Reconexão com espera exponencial (1 s
  → 10 s). Na volta: `banco de volta: N gravacoes pendentes despejadas`.
- **Erro de dado** (restrição, tipo) descarta só aquela linha, com log — uma
  linha ruim não trava a fila.
- **Banco fora na partida:** o serviço espera `esperaPartidaMs` (4 s) e segue
  em memória com o `config.json`. Quando o banco volta, o snapshot antigo
  **não** é sobrescrito pelo estado novo: primeiro é **mesclado** de forma
  conservadora (união das doses, maior contador, bloqueios preservados) e só
  então os snapshots voltam a ser gravados.

## 5. Perfil de cuidado por espécie, grupo e vaso

`parametros` é um perfil **parcial** — só o que difere do `config.json` —
validado por `contrato/v1/perfil-cuidado.schema.json`:

| Seção | Chaves |
|---|---|
| `regra` | `limiarLiga`, `limiarDesliga`, `duracaoPulsoMs`, `cooldownMs` |
| `ambiente` | `umidadeArMin`, `histerese` |
| `adubacao` | `ec25MinUsCm`, `ec25MaxUsCm`, `umidadeMinPct`, `maxDoses`, `janelaDosesMs` |

**Precedência** (o último vence):

```
config.json  <-  espécie  <-  grupo  <-  vaso  <-  variável de ambiente
```

- **espécie** — o que a planta precisa (suculenta: solo seco, pouco adubo);
- **grupo** — o que o lugar impõe (varanda com sol: cooldown menor);
- **vaso** — exceção daquele vaso;
- **variável de ambiente** — a "alteração ao vivo" do README continua vencendo.

O serviço relê o cadastro a cada `intervaloPerfilMs` (15 s) e aplica **sem
reiniciar**, registrando a origem de cada valor:

```
PERFIL     vaso-01 "Jiboia da sala" especie=samambaia grupo=sala
PERFIL     regra.limiarLiga: 30 -> 45 (especie:samambaia)
```

Uma camada inválida (campo desconhecido, fora da faixa, tipo errado) é
**ignorada** com o motivo; uma combinação incoerente (`limiarLiga ≥
limiarDesliga`, EC mín ≥ máx) não é aplicada. Parâmetros de segurança
(assinatura, TTL de comando, validade) **não** fazem parte do perfil: o schema
recusa.

Espécies do `persistencia/seed.sql` (valores de demonstração, na escala
simulada do projeto — não recomendação agronômica): `jiboia` (= padrão),
`samambaia`, `suculenta`, `orquidea`; grupos `sala` e `varanda-sol`.

## 6. Testes e evidências

| Comando | Cobre | Resultado |
|---|---|---|
| `npm run teste:unidade` | `persistencia/test/`: fila (queda, volta, limite, linha ruim, snapshot), perfil (precedência, schema, coerência, aplicação em lugar), restauração de cada regra | 26/26 — [`evidencias/teste-unidade.txt`](evidencias/teste-unidade.txt) |
| `npm run teste:persistencia` | `scripts/teste-persistencia.js`, com broker e serviço reais e o banco `naodenemagua_teste` (abaixo) | 37/37 — [`evidencias/teste-persistencia.txt`](evidencias/teste-persistencia.txt) |
| `npm run teste` | regressão do Marco 2–4 com `PERSISTENCIA_HABILITADA=0` | 95/95 |

Cenários do `teste:persistencia` (relacionados ao que o PDF pede em
"Persistência: gravação, recuperação e preservação após reiniciar o componente
responsável"):

| # | Passos | Esperado / observado |
|---|---|---|
| 1 | EC baixa → dose; solo seco → pulso sem efeito; um `eventId` reenviado | telemetria, comandos, acks, alertas e transições nas hypertables; `eventId` repetido = 1 linha; `solo_1min` responde |
| 2 | **`SIGKILL` no serviço** (sem snapshot de despedida) e nova partida | `restaurado do banco`; irrigação continua bloqueada; solo seco não gera pulso; EC baixa esbarra em `limite_de_doses_na_janela`; `eventId` antigo é `DUPLICADO`; `cmd-` continua a numeração |
| 3 | `docker compose stop timescaledb` com o serviço rodando; depois `start` | serviço segue vivo e processando; `banco de volta: N gravacoes pendentes despejadas`; leituras da queda estão no banco |
| 4 | reinício do contêiner | dados e cadastro anteriores continuam (volume) |
| 5 | `UPDATE vasos SET especie_id='samambaia'`; depois parâmetro no vaso; depois parâmetro inválido | `30 -> 45 (especie:samambaia)` e solo a 40% vira `AUTORIZADO`; `45 -> 35 (vaso:vaso-01)` e volta a `NORMAL`; inválido ignorado |
| 6 | conectar como `leitor_app` | `SELECT` funciona; `INSERT` recusado com `42501` |

`npm run teste:persistencia -- --sem-queda-banco` pula os cenários 3 e 4 (não
para o contêiner).

### Roteiro manual (vídeo)

1. `npm run banco`, `npm run banco:seed`, depois os quatro terminais do README.
2. `n` no simulador (dose) e `f` + `s` (bomba sem fluxo → bloqueio).
3. `Ctrl+C` no serviço e `npm run servico` de novo: o log mostra
   `ESTADO restaurado do banco (...)` com a dose e o bloqueio.
4. `npm run banco:consultar`: contagens, `solo_1min`, últimos alertas e
   comandos com o ack, snapshot.
5. `npm run banco:consultar -- --especie suculenta`: em até 15 s o serviço
   loga `PERFIL regra.limiarLiga: 30 -> 15 (especie:suculenta)`.
6. `npm run banco:parar` com tudo rodando → serviço segue; `npm run banco` → fila
   despejada.

## 7. Limitações

- **Restauração só na partida.** Um snapshot antigo nunca sobrescreve estado
  vivo; com o banco fora na partida há só a mescla conservadora (§4).
- **Fila em memória.** Se o serviço morrer *com o banco fora*, o que estava na
  fila se perde (o snapshot anterior continua no banco). Com até 10 000 linhas
  (~1 h de telemetria a 3 eventos/s), o descarte é das mais antigas.
- **Janela de 2 s** entre snapshots: um `SIGKILL` pode perder a última mudança
  de estado — exceto o que a política de "dose em curso conta" já cobre.
- **Acks de comandos anteriores ao reinício** são registrados no histórico,
  mas não corrigem estado (o serviço não reconhece comandos que não guardou).
- **Um serviço, um vaso.** O cadastro e as tabelas já são por `vaso_id`; o
  serviço ainda atende o `vaso-01` do `config.json`.
- **Retenção** da telemetria bruta é aplicada quando a política é criada;
  mudar `retencaoDias` depois exige `remove_retention_policy` manual.
- **Sem TLS entre serviço e banco**: o banco só escuta em `127.0.0.1`, na mesma
  máquina. Em implantação distribuída, seria preciso `ssl` no `pg`.
- **Fotos**: só a tabela de metadados; upload e armazenamento entram com o app.

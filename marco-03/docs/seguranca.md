# Marco 3 — Segurança da fronteira produtor-consumidor

**Projeto:** *Não dê nem água* — cuidado assistido de plantas de interior
**Disciplina:** Software para Sistemas Ubíquos — UFG
**Integrantes:** Matheus Vieira Mendes Pacheco, Davi Duarte Neco, Bárbara Nogueira

O Marco 2 terminou com uma limitação declarada: *"sem TLS e sem autenticação — qualquer um pode assinar e publicar nos tópicos"*. No caminho B, isso queria dizer que **qualquer pessoa na internet podia publicar em `command/irrigacao` e ligar a nossa bomba**. Este documento descreve como o Marco 3 fecha esse buraco em três camadas, mais uma quarta que vale mesmo quando o broker não é confiável.

---

## 1. Ameaças consideradas

| # | Ameaça | Exemplo no nosso sistema | Camada que protege |
|---|---|---|---|
| A1 | Escuta ou adulteração no caminho | alguém na mesma rede lê a telemetria ou troca 60% por 20% | **TLS** |
| A2 | Broker falso (*man-in-the-middle*) | um servidor se passa pelo broker e recebe tudo | **TLS + verificação do certificado** |
| A3 | Cliente desconhecido conectando | script anônimo conecta e publica | **usuário/senha** |
| A4 | Cliente conhecido fazendo o que não deve | o notificador publica um comando de irrigação | **ACL** |
| A5 | Dispositivo se passando por outro | o gateway do vaso-01 publica como vaso-02, ou com outro `deviceId` | **ACL + checagem de `deviceId`** |
| A6 | Broker não confiável | no HiveMQ público, um anônimo publica um comando forjado | **HMAC por mensagem** |
| A7 | Credencial vazada | um atacante obtém a senha do serviço | **HMAC** (defesa em profundidade) |
| A8 | Repetição de mensagem legítima | o mesmo comando reenviado para irrigar de novo | `idempotencyKey` + `expiresAtDeviceMs` (do Marco 2) + HMAC |

---

## 2. As camadas

### 2.1 Canal — TLS

| Caminho | Broker | Confiança no certificado |
|---|---|---|
| A (Node) | Aedes em `mqtts://localhost:8883` | **CA própria** do grupo (`seguranca/certs/ca.crt`), gerada por `npm run seguranca` |
| B (Wokwi) | `mqtts://broker.hivemq.com:8883` | **Amazon Root CA 1**, fixada no sketch |

- **Não existe porta em texto puro.** Um cliente MQTT sem TLS não completa nem o handshake (`TLS_RECUSADO` no log do broker).
- O cliente **confere o certificado** (`rejectUnauthorized: true` / `setCACert`). Um canal cifrado com um interlocutor desconhecido não é um canal seguro, por isso não usamos `setInsecure()`.
- O certificado do broker local vale só para `localhost` e `127.0.0.1` (SAN) e é assinado pela CA. Os clientes confiam na **CA**, não num certificado específico: é o mesmo modelo da web, em escala de bancada.
- O mínimo aceito é TLS 1.2.

### 2.2 Identificação e autenticação — usuário/senha (caminho A)

Cada componente tem uma **identidade**, listada em [`seguranca/acl.json`](../seguranca/acl.json):

| Identidade | Papel | Quem usa |
|---|---|---|
| `sim-vaso-01` | gateway do vaso-01 | simulador Node |
| `esp32-vaso-01` | gateway do vaso-01 | ESP32 (se ligado ao broker local) |
| `servico-irrigacao` | serviço | consumidor que decide e comanda |
| `notificador` | notificador | consumidor dos alertas (novo ciclo) |
| `observador` | observador | segundo consumidor, só leitura |

- O broker guarda apenas **hash scrypt + sal** de cada senha (`credenciais.json`). Cada cliente guarda a própria senha (`segredos.json`), o que equivale ao provisionamento do dispositivo.
- A comparação é feita em **tempo constante** (`timingSafeEqual`).
- Usuário inexistente e senha errada recebem **a mesma resposta** (CONNACK 4). Diferenciar os dois casos revelaria quais usuários existem.
- **O `clientId` precisa começar pela identidade.** Sem essa regra, uma identidade válida poderia usar o `clientId` de outra e derrubá-la, porque o MQTT encerra a sessão anterior que tem o mesmo id.
- No **broker público** o cliente **não envia senha**: entregá-la a um broker de terceiros seria vazá-la. Nesse caminho, quem identifica o dispositivo é o HMAC (2.4).

### 2.3 Autorização — ACL por papel (caminho A)

Aplicada pelo broker a **cada** `PUBLISH` (inclusive à *will message*) e a cada `SUBSCRIBE`:

| Papel | Publica | Assina |
|---|---|---|
| gateway | `vaso/{seu vaso}/telemetry/soil`, `.../status/heartbeat`, `.../ack/irrigacao` | `vaso/{seu vaso}/command/irrigacao` |
| serviço | `vaso/+/command/irrigacao`, `vaso/+/alert/#` | `vaso/+/telemetry/#`, `vaso/+/status/#`, `vaso/+/ack/#` |
| notificador | — | `vaso/+/alert/#` |
| observador | — | `naodenemagua/v1/#` |

- O gateway fica **amarrado ao próprio vaso**: não publica nem assina nada de outro vaso, nem por curinga (`vaso/+/command/#` é negado).
- **Checagem de `deviceId`:** para gateways, o broker confere se o `deviceId` *dentro do payload* é o da identidade autenticada. O tópico já está amarrado ao vaso; essa checagem fecha a mentira que ainda restava, a de quem diz ter medido.
- **Publicação negada derruba a conexão.** O MQTT 3.1.1 não tem resposta "publicação negada", e um cliente que publica fora da ACL está se comportando mal. **Assinatura negada** apenas devolve SUBACK `0x80` para aquele filtro e a sessão continua.

### 2.4 Autenticidade da mensagem — HMAC-SHA256 (caminhos A e B)

Usuário/senha autenticam a **conexão** com um broker em que confiamos. O HMAC autentica a **mensagem**, e continua valendo quando o broker é público.

- **Chave por dispositivo**, compartilhada entre o dispositivo e o serviço ([`seguranca/chaves-hmac.json`](../seguranca/chaves-hmac.json)).
- O **dispositivo assina** telemetria, heartbeat, *will message* e ack. O **serviço assina** cada comando com a chave do dispositivo que vai executá-lo.
- O **serviço rejeita** mensagem de dispositivo sem assinatura válida *antes* de validar o schema (`ASSINATURA_AUSENTE`, `ASSINATURA_INVALIDA`, `DISPOSITIVO_DESCONHECIDO`, `VASO_NAO_PERTENCE_AO_DISPOSITIVO`).
- O **dispositivo recusa** comando sem assinatura válida *antes* de qualquer outra verificação e responde `REJEITADO_ASSINATURA`. A bomba não liga. Quem sofre a consequência física é o dispositivo, então a última barreira fica nele.

**Formato.** `sig` é sempre o **último campo** do JSON:

```
{"schemaVersion":1, ... ,"valid":true,"sig":"<64 hex>"}
sig = HMAC-SHA256(chave, topico + "\n" + corpo)      corpo = o JSON sem o campo sig
```

- Assina-se o **texto exato** e não o objeto. O ESP32 imprime `20.0` onde o JavaScript imprime `20`; com o texto exato, nenhum dos lados precisa reproduzir a serialização do outro.
- O **tópico entra na assinatura**: uma mensagem legítima copiada para o tópico de outro vaso deixa de valer.
- Comparação em tempo constante nos dois lados.

**Contrato.** `sig` entrou nos quatro schemas como campo **opcional**. Pela regra de evolução do contrato, acrescentar campo opcional mantém a v1. A obrigatoriedade é uma **política** do serviço (`seguranca.exigirAssinatura`), e não uma mudança de schema. O novo resultado `REJEITADO_ASSINATURA` em `ConfirmacaoAtuacao` amplia um enum. Como produtor e consumidor evoluíram juntos, mantivemos a v1 e registramos aqui a decisão.

---

## 3. Onde cada camada vive

```
   gateway (sim / ESP32)                 BROKER                        servico-irrigacao
   ─────────────────────        ───────────────────────────        ──────────────────────────
   assina tudo (HMAC)  ──TLS──▶ 1 TLS (só 8883)                     confere HMAC do dispositivo
   confere HMAC do               2 usuário/senha (scrypt)             antes do schema
   comando ◀──────────TLS─────── 3 ACL por papel + deviceId ◀─TLS── assina o comando com a
   REJEITADO_ASSINATURA          (caminho A apenas)                   chave do dispositivo
                                                                    notificador / observador:
                                                                      só assinam (ACL)
```

| Camada | Caminho A (local) | Caminho B (Wokwi, broker público) |
|---|:---:|:---:|
| TLS com verificação do certificado | ✅ CA própria | ✅ Amazon Root CA 1 |
| Usuário/senha | ✅ | ❌ (broker de terceiros) |
| ACL + checagem de `deviceId` | ✅ | ❌ (broker de terceiros) |
| HMAC por mensagem | ✅ | ✅ |

---

## 4. Como verificar

```bash
npm run teste
```

As seções 8 a 12 do teste cobrem a segurança: 20 verificações (mais uma na seção 2, que confere que o comando chega assinado), todas com controle positivo, porque recusar tudo também "passaria" num teste ingênuo.

| Seção | Verifica |
|---|---|
| 8 Canal | texto puro não conecta; cliente sem a CA recusa o broker |
| 9 Identidade | sem senha, senha errada, usuário inexistente e `clientId` alheio são recusados; identidade válida conecta |
| 10 Autorização | notificador e observador não publicam; gateway não assina nem publica em outro vaso; `deviceId` falso é barrado |
| 11 HMAC no serviço | leituras secas sem assinatura, adulteradas ou com chave errada não geram comando; as mesmas leituras assinadas geram |
| 12 HMAC no dispositivo | comando com assinatura falsa e sem assinatura → `REJEITADO_ASSINATURA` |

**Ataques ao vivo**, com broker, serviço e simulador ligados:

```bash
npm run ataque -- texto-puro
npm run ataque -- sem-ca
npm run ataque -- sem-senha
npm run ataque -- senha-errada
npm run ataque -- notificador-comanda
npm run ataque -- vaso-alheio
npm run ataque -- comando-forjado
```

E pelo teclado do simulador: `a` (leitura sem assinatura), `g` (adulterada depois de assinar), `o` (`deviceId` de outro dispositivo) e `c` (tópico de outro vaso).

---

## 5. Limitações declaradas

1. **Chaves HMAC versionadas.** As chaves de demonstração estão no repositório porque o sketch do Wokwi precisa contê-las. Em produção seriam provisionadas por dispositivo e guardadas na NVS com *flash encryption* do ESP32.
2. **Senhas e certificados não são versionados.** Cada máquina gera os seus com `npm run seguranca`. A chave privada da CA fica no disco da bancada, sem HSM.
3. **Caminho B sem ACL nem senha.** O broker público não tem nenhum dos dois. Ali, a autenticidade das mensagens depende só do HMAC, e a confidencialidade vale apenas até o broker: o HiveMQ público entrega o conteúdo a qualquer assinante do tópico.
4. **Chave simétrica.** Quem tem a chave do dispositivo pode assinar tanto como dispositivo quanto como serviço. Separar os papéis exigiria assinatura assimétrica (ECDSA) ou mTLS com certificados por dispositivo, fora do escopo deste marco.
5. **Repetição de telemetria.** Uma leitura legítima reenviada é barrada pela deduplicação por `eventId`, mas o conjunto de ids vistos é limitado (500) e fica em memória. Comandos têm proteção própria (`idempotencyKey` + prazo no relógio do dispositivo).
6. **Sem revogação.** Para trocar uma credencial é preciso rodar `npm run seguranca -- --forcar` e reiniciar os componentes. Não há rotação automática.

---

## 6. Integração com o ciclo de alertas (outro ramo)

O ciclo `servico-irrigacao` → `notificador` (`AlertaCuidado`) está sendo feito em
outro ramo. Para ele se encaixar nesta camada:

- **Conexão:** use `contrato.conectar(cfg, '<identidade>', { clientId: '<identidade>-...' })`
  em vez de `mqtt.connect`. A função monta TLS e credenciais para os dois caminhos.
- **Identidades e ACL já preparadas:** o serviço já pode publicar em
  `naodenemagua/v1/vaso/+/alert/#`, e a identidade `notificador` só pode
  assinar esse ramo. Um tópico de alerta fora de `alert/` exige ajuste em
  `seguranca/acl.json`.
- **Assinatura dos alertas:** não é obrigatória. A ACL garante que só o serviço
  publica em `alert/`, e o HMAC por dispositivo foi pensado para a fronteira com
  o dispositivo. Se quiserem assinar também, seria preciso criar uma chave do
  serviço, à parte das chaves dos dispositivos.
- **Teste:** os novos casos devem conectar com `conectarComo('<identidade>')`
  no `teste-integracao.js`.

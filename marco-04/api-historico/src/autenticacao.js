'use strict';
/*
 * Identidade e autorizacao da API de historico -- as MESMAS do broker.
 *
 *   identidade   usuario/senha (HTTP Basic, so dentro do TLS), conferidos contra
 *                os hashes scrypt de seguranca/credenciais.json. Um usuario a
 *                mais nao existe: o app usa a credencial que ja tem.
 *   autorizacao  papel `app` da ACL e o vaso da identidade. Quem le o vaso-01 e
 *                o app do vaso-01 -- nem outro app, nem o notificador, nem o
 *                servico (que tem acesso proprio ao banco).
 *   forca bruta  falhas de senha por IP numa janela: passou do limite, 429 SEM
 *                conferir a senha (o scrypt e caro de proposito, e nao pode
 *                virar alavanca de negacao de servico).
 */

/* "Basic base64(usuario:senha)" -> { usuario, senha } ou null. */
function lerBasic(cabecalho) {
  if (typeof cabecalho !== 'string') return null;
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(cabecalho.trim());
  if (!m) return null;
  const texto = Buffer.from(m[1], 'base64').toString('utf8');
  const i = texto.indexOf(':');
  if (i <= 0) return null;
  return { usuario: texto.slice(0, i), senha: texto.slice(i + 1) };
}

/* Decisao de autorizacao, separada para teste: { ok } ou { ok: false, motivo }. */
function autorizar(identidade, vasoId) {
  if (!identidade) return { ok: false, motivo: 'identidade desconhecida' };
  if (identidade.papel !== 'app') return { ok: false, motivo: `papel ${identidade.papel} nao le historico pela API` };
  if (identidade.vasoId !== vasoId) return { ok: false, motivo: `${identidade.nome} nao e do ${vasoId}` };
  return { ok: true };
}

class LimiteTentativas {
  constructor(maximo, janelaMs) {
    this.maximo = maximo;
    this.janelaMs = janelaMs;
    this.falhas = new Map(); // ip -> [instantes]
  }

  recentes(ip, agora) {
    const lista = (this.falhas.get(ip) || []).filter((t) => agora - t < this.janelaMs);
    if (lista.length) this.falhas.set(ip, lista);
    else this.falhas.delete(ip);
    return lista;
  }

  bloqueado(ip, agora) {
    return this.recentes(ip, agora).length >= this.maximo;
  }

  /* Segundos ate a falha mais antiga sair da janela. */
  esperaS(ip, agora) {
    const lista = this.recentes(ip, agora);
    return lista.length ? Math.ceil((lista[0] + this.janelaMs - agora) / 1000) : 0;
  }

  falhou(ip, agora) {
    this.falhas.set(ip, [...this.recentes(ip, agora), agora]);
  }

  acertou(ip) {
    this.falhas.delete(ip);
  }
}

module.exports = { lerBasic, autorizar, LimiteTentativas };

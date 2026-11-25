package br.ufg.naodenemagua.conexao

import android.content.Context
import br.ufg.naodenemagua.R
import org.json.JSONObject
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** O que a verificacao diz de uma mensagem do servico. */
enum class Autenticidade { VALIDA, AUSENTE, INVALIDA }

/** Chave HMAC de uma identidade `app` e o vaso a que ela pertence. */
class ChaveApp(val vasoId: String, val chave: ByteArray)

/**
 * Assinatura das mensagens do app, nos dois sentidos -- o que torna o broker
 * PUBLICO (caminho B, o do ESP32 no Wokwi) utilizavel sem senha nem ACL. Mesmo
 * formato do Marco 3 (seguranca/index.js): a assinatura e o ULTIMO campo do
 * JSON e cobre `topico + "\n" + corpo` -- o texto exato, sem canonicalizacao,
 * e com o topico dentro (copiar a mensagem para outro topico a invalida).
 *
 *  - app -> servico: HMAC-SHA256 com a chave PROPRIA do app, campo `sig`.
 *  - servico -> app: ECDSA P-256 / SHA-256, campo `assinatura` (DER em hex).
 *    O app tem so a chave PUBLICA: confere, mas nao consegue forjar. Com HMAC,
 *    a chave extraida do APK serviria para publicar um estado falso.
 */
object Assinaturas {

    private val SUFIXO_ASSINATURA = Regex(""","assinatura":"([0-9a-f]{120,150})"\}$""")

    fun hmacHex(chave: ByteArray, topico: String, corpo: String): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(chave, "HmacSHA256")) }
        return hex(mac.doFinal("$topico\n$corpo".toByteArray(Charsets.UTF_8)))
    }

    /** Recebe o JSON (texto) e devolve o mesmo texto com `,"sig":"..."` no fim. */
    fun assinarApp(chave: ByteArray, topico: String, corpo: String): String {
        require(corpo.endsWith("}")) { "corpo nao e um objeto JSON" }
        return corpo.dropLast(1) + ",\"sig\":\"" + hmacHex(chave, topico, corpo) + "\"}"
    }

    fun verificarServico(chavePublica: PublicKey, topico: String, texto: String): Autenticidade {
        val m = SUFIXO_ASSINATURA.find(texto) ?: return Autenticidade.AUSENTE
        val corpo = texto.substring(0, m.range.first) + "}"
        return try {
            val verificador = Signature.getInstance("SHA256withECDSA").apply {
                initVerify(chavePublica)
                update("$topico\n$corpo".toByteArray(Charsets.UTF_8))
            }
            if (verificador.verify(desHex(m.groupValues[1]))) Autenticidade.VALIDA else Autenticidade.INVALIDA
        } catch (_: GeneralSecurityException) {
            Autenticidade.INVALIDA // DER malformado tambem e assinatura invalida
        }
    }

    /** Chave publica EC no formato PEM "PUBLIC KEY" (SPKI), como o Node exporta. */
    fun chavePublicaDePem(pem: String): PublicKey {
        val base64 = pem.lineSequence().filterNot { it.startsWith("-----") }.joinToString("").trim()
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(base64)))
    }

    /** seguranca/certs/chaves-app.json -> chave de cada identidade `app`. */
    fun chavesAppDeJson(texto: String): Map<String, ChaveApp> {
        val apps = JSONObject(texto).optJSONObject("apps") ?: return emptyMap()
        return apps.keys().asSequence().associateWith { id ->
            val a = apps.getJSONObject(id)
            ChaveApp(a.getString("vasoId"), desHex(a.getString("chave")))
        }
    }

    internal fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    internal fun desHex(texto: String): ByteArray {
        require(texto.length % 2 == 0)
        return ByteArray(texto.length / 2) { i -> texto.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}

/**
 * Material de assinatura embutido no APK pelo build (copiado de
 * marco-04/seguranca/certs por `npm run seguranca`, ver app/build.gradle.kts).
 */
class MaterialAssinatura(val chavePublicaServico: PublicKey, private val chavesApp: Map<String, ChaveApp>) {

    /** Chave HMAC do usuario para este vaso; null se o APK nao tem chave para ele. */
    fun chaveDoApp(usuario: String, vasoId: String): ByteArray? =
        chavesApp[usuario]?.takeIf { it.vasoId == vasoId }?.chave

    companion object {
        fun carregar(contexto: Context): MaterialAssinatura {
            val r = contexto.resources
            val pem = r.openRawResource(R.raw.servico_assinatura).bufferedReader().use { it.readText() }
            val apps = r.openRawResource(R.raw.chaves_app).bufferedReader().use { it.readText() }
            return MaterialAssinatura(Assinaturas.chavePublicaDePem(pem), Assinaturas.chavesAppDeJson(apps))
        }
    }
}

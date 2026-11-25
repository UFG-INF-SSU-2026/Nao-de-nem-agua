package br.ufg.naodenemagua.conexao

import android.content.Context
import br.ufg.naodenemagua.R
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

/**
 * Canal seguro: o app confia SOMENTE na CA propria do grupo (a mesma que assina
 * o certificado do broker), e nao nas CAs do sistema. Um servidor com
 * certificado de qualquer outra origem -- inclusive valido na internet -- e
 * recusado no handshake.
 *
 * O ca.crt e copiado de marco-04/seguranca/certs a cada build (ver
 * app/build.gradle.kts). E publico: a chave da CA nunca entra no app.
 */
object TlsDoGrupo {

    fun fabricaDeSockets(contexto: Context): SSLSocketFactory {
        val certificados = CertificateFactory.getInstance("X.509")
        val ca = contexto.resources.openRawResource(R.raw.ca_naodenemagua).use {
            certificados.generateCertificate(it)
        }
        val confiaveis = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("ca-naodenemagua", ca)
        }
        val gerente = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(confiaveis)
        }
        return SSLContext.getInstance("TLS").apply {
            init(null, gerente.trustManagers, null)
        }.socketFactory
    }
}

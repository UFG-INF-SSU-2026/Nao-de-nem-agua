package br.ufg.naodenemagua

import br.ufg.naodenemagua.conexao.ordenarIpv4Primeiro
import br.ufg.naodenemagua.conexao.urisPorEndereco
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress

/**
 * Broker publico em rede movel: o DNS do HiveMQ devolve IPv6 primeiro, e o
 * IPv6 recusa a porta 8883 (visto no aparelho, rede 5G). O app tenta IPv4 antes.
 */
class EnderecosTest {

    @Test
    fun ipv4VemAntesDoIpv6MantendoAOrdemDoDns() {
        val dns = listOf("2a01:578:13::12c5:fd2", "2a01:578:13::3fb0:e09f", "18.197.15.210", "63.176.224.159")
            .map { InetAddress.getByName(it) }
        assertEquals(
            listOf("18.197.15.210", "63.176.224.159", "2a01:578:13:0:0:0:12c5:fd2", "2a01:578:13:0:0:0:3fb0:e09f"),
            ordenarIpv4Primeiro(dns).map { it.hostAddress }
        )
    }

    @Test
    fun ipLiteralViraUriComColchetesNoIpv6() {
        assertEquals(listOf("ssl://127.0.0.1:8883"), urisPorEndereco("127.0.0.1", 8883))
        assertEquals(listOf("ssl://[0:0:0:0:0:0:0:1]:8883"), urisPorEndereco("::1", 8883))
    }
}

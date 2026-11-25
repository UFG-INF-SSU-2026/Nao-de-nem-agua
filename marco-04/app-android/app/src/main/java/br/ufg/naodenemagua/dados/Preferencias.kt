package br.ufg.naodenemagua.dados

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import br.ufg.naodenemagua.conexao.ConfigConexao
import kotlinx.coroutines.flow.first

private val Context.armazenamento by preferencesDataStore(name = "conexao")

/**
 * Dados de conexao lembrados no proprio aparelho (armazenamento privado do app,
 * fora do backup: allowBackup=false no manifesto). A senha so e guardada se o usuario marcar
 * "lembrar"; ela nunca esta no codigo nem no repositorio.
 */
class Preferencias(private val contexto: Context) {

    suspend fun ler(): ConfigConexao {
        val p = contexto.armazenamento.data.first()
        return ConfigConexao(
            host = p[HOST] ?: PADRAO.host,
            porta = p[PORTA] ?: PADRAO.porta,
            usuario = p[USUARIO] ?: PADRAO.usuario,
            senha = p[SENHA] ?: "",
            vasoId = p[VASO] ?: PADRAO.vasoId
        )
    }

    suspend fun salvar(config: ConfigConexao, lembrarSenha: Boolean) {
        contexto.armazenamento.edit { p ->
            p[HOST] = config.host
            p[PORTA] = config.porta
            p[USUARIO] = config.usuario
            p[VASO] = config.vasoId
            if (lembrarSenha) p[SENHA] = config.senha else p.remove(SENHA)
        }
    }

    suspend fun esquecerSenha() {
        contexto.armazenamento.edit { it.remove(SENHA) }
    }

    /** A apresentacao (boas-vindas) so aparece na primeira abertura do app. */
    suspend fun boasVindasVista(): Boolean = contexto.armazenamento.data.first()[BOAS_VINDAS] == true

    suspend fun marcarBoasVindasVista() {
        contexto.armazenamento.edit { it[BOAS_VINDAS] = true }
    }

    companion object {
        /** Padrao do caminho A pelo cabo USB (adb reverse tcp:8883 tcp:8883). */
        val PADRAO = ConfigConexao(host = "localhost", porta = 8883, usuario = "app-vaso-01", senha = "", vasoId = "vaso-01")

        private val HOST = stringPreferencesKey("host")
        private val PORTA = intPreferencesKey("porta")
        private val USUARIO = stringPreferencesKey("usuario")
        private val SENHA = stringPreferencesKey("senha")
        private val VASO = stringPreferencesKey("vaso")
        private val BOAS_VINDAS = booleanPreferencesKey("boas_vindas_vista")
    }
}

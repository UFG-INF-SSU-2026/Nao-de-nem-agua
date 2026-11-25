plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

/*
 * Marco 4: o app confia SO na CA propria do grupo (a mesma que assina o
 * certificado do broker). O ca.crt e publico, mas e gerado por maquina
 * (`npm run seguranca`, fora do Git): por isso ele e copiado a cada build para
 * um recurso gerado (res/raw/ca_naodenemagua.crt), em vez de versionado aqui.
 * A chave da CA (ca.key) nunca entra no app.
 */
abstract class CopiarCaDoGrupo : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val ca: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val saida: DirectoryProperty

    @TaskAction
    fun copiar() {
        val origem = ca.singleFile
        if (!origem.exists()) {
            throw GradleException(
                "CA do grupo nao encontrada em ${origem.path}. Rode `npm run seguranca` na pasta marco-04 antes de compilar o app."
            )
        }
        val raw = saida.get().dir("raw").asFile
        raw.mkdirs()
        origem.copyTo(raw.resolve("ca_naodenemagua.crt"), overwrite = true)
    }
}

val copiarCaDoGrupo = tasks.register<CopiarCaDoGrupo>("copiarCaDoGrupo") {
    ca.from(rootProject.file("../seguranca/certs/ca.crt"))
}

androidComponents {
    onVariants { variante ->
        variante.sources.res?.addGeneratedSourceDirectory(copiarCaDoGrupo, CopiarCaDoGrupo::saida)
    }
}

android {
    namespace = "br.ufg.naodenemagua"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "br.ufg.naodenemagua"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0-marco4"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // Publicacao em loja e dispensada (PDF do Marco 4): o APK de entrega e
            // assinado com a chave de DEPURACAO do Android Studio, que existe em
            // qualquer maquina de desenvolvimento. Assim nenhuma chave de
            // assinatura nova precisa ser criada, guardada ou ficar fora do Git.
            // Limitacao declarada em docs/implantacao.md.
            signingConfig = signingConfigs.getByName("debug")
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    // Marco 4
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.paho.mqttv3)
    // org.json existe no Android, mas nos testes de JVM e um stub: a versao real entra so no teste.
    testImplementation(libs.org.json)
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
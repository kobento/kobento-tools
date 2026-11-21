import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The showcases come from kobento-mcp's example catalog: examples/SHW-*/ (doc.rc and its mono
// looks, the light and dark renders as thumbnails, meta.json), and docs/examples-vocabulary.json
// for the capability labels. A sibling checkout, or KOBENTO_MCP.
val kobentoMcp: File = (System.getenv("KOBENTO_MCP") ?: providers.gradleProperty("kobentoMcp").orNull)
    ?.let { file(it) } ?: rootDir.resolve("../../kobento-mcp")
val examplesDir = kobentoMcp.resolve("examples")
val vocabularyFile = kobentoMcp.resolve("docs/examples-vocabulary.json")

/** Copies the SHW showcases from kobento-mcp/examples into generated assets (showcases/<folder>/), and the vocabulary. */
abstract class SyncShowcases : DefaultTask() {
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val examples: ConfigurableFileCollection
    @get:Internal abstract val examplesRoot: DirectoryProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val vocabulary: RegularFileProperty
    @get:OutputDirectory abstract val output: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction fun sync() {
        val root = examplesRoot.get().asFile
        if (!root.isDirectory) {
            throw GradleException("No showcases at $root: check out kobento-mcp next to kobento-tools, or set KOBENTO_MCP.")
        }
        fs.sync {
            from(root) { include(SHOWCASE_FILES); into("showcases") }
            from(vocabulary)
            into(output)
        }
    }

    companion object {
        val SHOWCASE_FILES = listOf("SHW-*/doc.rc", "SHW-*/doc.mono-dark.rc", "SHW-*/doc.mono-light.rc",
            "SHW-*/render-light.png", "SHW-*/render-dark.png", "SHW-*/meta.json")
    }
}

val syncShowcases by tasks.registering(SyncShowcases::class) {
    description = "Copies the SHW showcases from kobento-mcp/examples into the app's assets."
    examplesRoot.set(examplesDir)
    vocabulary.set(vocabularyFile)
    examples.from(fileTree(examplesDir) { include(SyncShowcases.SHOWCASE_FILES) })
}

androidComponents {
    onVariants { variant -> variant.sources.assets?.addGeneratedSourceDirectory(syncShowcases, SyncShowcases::output) }
}

android {
    namespace = "dev.kobento.showcases"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.kobento.showcases"
        minSdk = 26   // the RemoteCompose player's
        targetSdk = 37
        // Each upload to Play needs a higher versionCode: -PversionCode=2 (or edit it here).
        versionCode = providers.gradleProperty("versionCode").getOrElse("1").toInt()
        versionName = providers.gradleProperty("versionName").getOrElse("1.0")
        // The server to sign in to: -PkobentoServer=... (a launch can name another: `--es server`).
        val server = providers.gradleProperty("kobentoServer").getOrElse("https://mcp.kobento.dev")
        buildConfigField("String", "KOBENTO_SERVER", "\"$server\"")
    }

    // The upload key for Google Play (Play App Signing keeps the real one): android/keystore.properties,
    // never committed, with storeFile, storePassword, keyAlias, keyPassword (see README). Without it
    // the release build is signed with the debug key: installable, not uploadable.
    val keystoreProps = rootProject.file("keystore.properties").takeIf { it.isFile }
        ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }
    signingConfigs {
        if (keystoreProps != null) create("upload") {
            storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
            storePassword = keystoreProps.getProperty("storePassword")
            keyAlias = keystoreProps.getProperty("keyAlias")
            keyPassword = keystoreProps.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    // The player's API is @RestrictTo(LIBRARY_GROUP) in the alphas: using it from an app is the point here.
    lint { disable += "RestrictedApi" }
}

dependencies {
    // The androidx RemoteCompose player (gradle.properties' remoteVersion). remote-core too: the
    // player's own types (RemoteComposePlayer extends one) are only on its runtime classpath.
    val remote = providers.gradleProperty("remoteVersion").get()
    @Suppress("UseTomlInstead")   // the version is a property, to switch between the snapshot and a release
    implementation("androidx.compose.remote:remote-player-view:$remote")
    @Suppress("UseTomlInstead")
    implementation("androidx.compose.remote:remote-core:$remote")
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.browser)
}

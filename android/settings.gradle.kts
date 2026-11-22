pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // A player built from a local androidx checkout (a change under review, say):
        // -PlocalRemoteRepo=<its repository directory>, the one `SNAPSHOT=1 ./gradlew
        // :compose:remote:remote-player-view:publish` fills (DIST_DIR/repository). The group then
        // comes only from there.
        val local = providers.gradleProperty("localRemoteRepo").orNull
        if (local != null) {
            exclusiveContent {
                forRepository { maven(file(local)) { name = "localRemoteCompose" } }
                filter { includeGroup("androidx.compose.remote") }
            }
        }
        google()
        mavenCentral()
        // The RemoteCompose player as androidx-main builds it (1.0.0-SNAPSHOT), from one pinned
        // androidx.dev build: gradle.properties' androidxSnapshotBuild. Only that group comes from it.
        val build = providers.gradleProperty("androidxSnapshotBuild").get()
        maven("https://androidx.dev/snapshots/builds/$build/artifacts/repository") {
            name = "androidxSnapshots"
            content { includeGroup("androidx.compose.remote") }
        }
    }
}

rootProject.name = "kobento-showcases"
include(":app")

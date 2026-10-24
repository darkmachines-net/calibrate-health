/** Wear plugin versions and strict dependency locking shared by every Android configuration. */

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.kapt) apply false
}

allprojects {
    dependencyLocking {
        lockAllConfigurations()
        lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
    }
}

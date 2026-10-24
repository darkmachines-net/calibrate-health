/** Wear Android build variants, validated server origins, shared signing, and strict dependency configuration. */

import java.io.File
import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.kapt)
}

/** Escapes a value as a quoted Java string literal for generated BuildConfig fields. */
fun quoteBuildConfig(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

/** Accepts only local hostnames or literal private/loopback addresses for cleartext development origins. */
fun privateOrLocalHost(rawHost: String): Boolean {
    val host = rawHost.lowercase().removePrefix("[").removeSuffix("]").substringBefore('%')
    if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true

    val ipv4 = host.split('.').mapNotNull { it.toIntOrNull() }
    if (ipv4.size == 4 && ipv4.all { it in 0..255 }) {
        return ipv4[0] == 10 ||
            ipv4[0] == 127 ||
            (ipv4[0] == 172 && ipv4[1] in 16..31) ||
            (ipv4[0] == 192 && ipv4[1] == 168)
    }

    if (host == "::1") return true
    val firstIpv6Group = host.substringBefore(':').toIntOrNull(16) ?: return false
    return firstIpv6Group in 0xfc00..0xfdff || firstIpv6Group in 0xfe80..0xfebf
}

/** Requires an origin-only HTTPS URL, allowing HTTP solely under explicit trusted-development policy. */
fun validateServerOrigin(rawValue: String, allowCleartext: Boolean): String {
    val value = rawValue.trim()
    val uri = try {
        URI(value)
    } catch (error: Exception) {
        throw GradleException("calibrateWearServerUrl must be a valid absolute server origin.", error)
    }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host
    val hasOriginOnly = uri.rawPath.isNullOrEmpty() &&
        uri.rawQuery == null &&
        uri.rawFragment == null &&
        uri.userInfo == null
    if (host.isNullOrBlank() || !hasOriginOnly || (uri.port != -1 && uri.port !in 1..65535)) {
        throw GradleException(
            "calibrateWearServerUrl must be an origin only, for example https://health.example.com."
        )
    }
    if (scheme == "https") return value
    if (scheme != "http") {
        throw GradleException("calibrateWearServerUrl must use HTTPS, or explicitly allowed private HTTP.")
    }
    if (!allowCleartext) {
        throw GradleException(
            "HTTP requires -PcalibrateWearAllowCleartext=true and is limited to loopback, private, or .local hosts."
        )
    }
    if (!privateOrLocalHost(host)) {
        throw GradleException("Public HTTP origins are not allowed; use HTTPS for $host.")
    }
    return value
}

/** Reads a Gradle boolean property and rejects values other than true or false. */
fun strictBooleanProperty(name: String, default: Boolean): Boolean {
    val value = providers.gradleProperty(name).orNull ?: return default
    return when (value.lowercase()) {
        "true" -> true
        "false" -> false
        else -> throw GradleException("$name must be exactly true or false.")
    }
}

enum class WearTaskBuildType {
    DEBUG,
    INTERNAL,
    RELEASE
}

/** Classifies a requested task by its target variant, checking Release before DebugSymbols substrings. */
fun wearTaskBuildType(taskName: String): WearTaskBuildType? = when {
    // Release symbol-stripping tasks contain "DebugSymbols" but still target the release variant.
    taskName.contains("Release") -> WearTaskBuildType.RELEASE
    taskName.contains("Internal") -> WearTaskBuildType.INTERNAL
    taskName.contains("Debug") -> WearTaskBuildType.DEBUG
    else -> null
}

/** Reads a nonblank signing value from a Gradle property or the corresponding environment variable. */
fun sharedSigningValue(name: String): String? =
    providers.gradleProperty(name).orElse(providers.environmentVariable(name)).orNull?.takeIf { it.isNotBlank() }

val configuredCleartext = strictBooleanProperty("calibrateWearAllowCleartext", false)
val configuredServerOrigin = validateServerOrigin(
    providers.gradleProperty("calibrateWearServerUrl").orElse("https://calibratehealth.app").get(),
    configuredCleartext
)
val configuredUsesCleartext = URI(configuredServerOrigin).scheme.equals("http", ignoreCase = true)
val debugServerOrigin = validateServerOrigin(
    providers.gradleProperty("calibrateWearDebugServerUrl").orElse("http://10.0.2.2:3000").get(),
    allowCleartext = true
)

val phoneDebugKeystore = rootProject.file("../mobile/android/app/debug.keystore")

val releaseSigningNames = listOf(
    "CALIBRATE_ANDROID_SIGNING_STORE_FILE",
    "CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD",
    "CALIBRATE_ANDROID_SIGNING_KEY_ALIAS",
    "CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD"
)
val releaseSigningValues = releaseSigningNames.associateWith(::sharedSigningValue)
val suppliedReleaseSigningNames = releaseSigningValues.filterValues { it != null }.keys
if (suppliedReleaseSigningNames.isNotEmpty() && suppliedReleaseSigningNames.size != releaseSigningNames.size) {
    val missing = releaseSigningNames.filterNot(suppliedReleaseSigningNames::contains)
    throw GradleException("Release signing is incomplete. Missing: ${missing.joinToString()}.")
}
val hasReleaseSigning = suppliedReleaseSigningNames.size == releaseSigningNames.size
val repositoryRoot = rootProject.projectDir.parentFile
val releaseStoreFile = releaseSigningValues["CALIBRATE_ANDROID_SIGNING_STORE_FILE"]?.let { path ->
    File(path).let { if (it.isAbsolute) it else repositoryRoot.resolve(path) }
}
if (hasReleaseSigning && releaseStoreFile?.isFile != true) {
    throw GradleException(
        "CALIBRATE_ANDROID_SIGNING_STORE_FILE does not point to a file. " +
            "Use an absolute path or a path relative to the repository root."
    )
}

android {
    namespace = "app.calibratehealth.wear"
    compileSdk = 36

    defaultConfig {
        // Wear Data Layer only connects artifacts with matching package names and signatures.
        applicationId = "net.darkmachines.healthtracker"
        minSdk = 30
        targetSdk = 36
        versionCode = 18
        versionName = "0.2.9"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DEFAULT_SERVER_URL", quoteBuildConfig(configuredServerOrigin))
        manifestPlaceholders["usesCleartextTraffic"] = configuredUsesCleartext
    }

    signingConfigs {
        getByName("debug") {
            storeFile = phoneDebugKeystore
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (hasReleaseSigning) {
            create("sharedRelease") {
                storeFile = releaseStoreFile
                storePassword = releaseSigningValues.getValue("CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD")
                keyAlias = releaseSigningValues.getValue("CALIBRATE_ANDROID_SIGNING_KEY_ALIAS")
                keyPassword = releaseSigningValues.getValue("CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            versionNameSuffix = "-debug"
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("String", "DEFAULT_SERVER_URL", quoteBuildConfig(debugServerOrigin))
            manifestPlaceholders["usesCleartextTraffic"] = true
        }
        create("internal") {
            initWith(getByName("release"))
            versionNameSuffix = "-internal"
            // Pair with an EAS-signed phone when shared credentials are supplied; otherwise support local debug pairing.
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("sharedRelease")
            } else {
                signingConfigs.getByName("debug")
            }
            matchingFallbacks += listOf("release")
            buildConfigField("String", "DEFAULT_SERVER_URL", quoteBuildConfig(configuredServerOrigin))
            manifestPlaceholders["usesCleartextTraffic"] = configuredUsesCleartext
        }
        release {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("sharedRelease")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kapt {
    arguments {
        arg("room.schemaLocation", "$projectDir/schemas")
        arg("room.incremental", "true")
    }
}

tasks.configureEach {
    val taskBuildType = wearTaskBuildType(name)
    if (
        (taskBuildType == WearTaskBuildType.DEBUG || taskBuildType == WearTaskBuildType.INTERNAL) &&
        !phoneDebugKeystore.isFile
    ) {
        doFirst {
            throw GradleException(
                "Phone debug keystore not found at ${phoneDebugKeystore.absolutePath}. " +
                    "Run 'npm --prefix mobile run prebuild:android' from the repository root first."
            )
        }
    }
    if (taskBuildType == WearTaskBuildType.RELEASE && !hasReleaseSigning) {
        doFirst {
            throw GradleException(
                "Release tasks require all CALIBRATE_ANDROID_SIGNING_* values so the phone and watch use the same certificate."
            )
        }
    }
}

tasks.register("testWearTaskBuildTypeClassification") {
    group = "verification"
    description = "Checks Wear task classification before signing guards run."
    doLast {
        mapOf(
            "assembleDebug" to WearTaskBuildType.DEBUG,
            "stripDebugDebugSymbols" to WearTaskBuildType.DEBUG,
            "assembleInternal" to WearTaskBuildType.INTERNAL,
            "stripInternalDebugSymbols" to WearTaskBuildType.INTERNAL,
            "assembleRelease" to WearTaskBuildType.RELEASE,
            "stripReleaseDebugSymbols" to WearTaskBuildType.RELEASE
        ).forEach { (taskName, expectedBuildType) ->
            check(wearTaskBuildType(taskName) == expectedBuildType) {
                "Expected $taskName to target $expectedBuildType."
            }
        }
        check(wearTaskBuildType("testWearServerOriginValidation") == null)
    }
}

tasks.register("testWearServerOriginValidation") {
    group = "verification"
    description = "Runs fast build-logic checks for allowed and rejected Wear server origins."
    doLast {
        listOf(
            "https://health.example.com" to false,
            "http://127.0.0.1:3000" to true,
            "http://10.0.2.2:3000" to true,
            "http://172.16.0.2" to true,
            "http://192.168.1.10" to true,
            "http://calibrate.local:3000" to true,
            "http://[::1]:3000" to true
        ).forEach { (origin, cleartext) ->
            check(validateServerOrigin(origin, cleartext) == origin)
        }
        listOf(
            "http://health.example.com" to true,
            "http://192.168.1.10" to false,
            "ftp://192.168.1.10" to true,
            "https://health.example.com/path" to false,
            "https://user@health.example.com" to false
        ).forEach { (origin, cleartext) ->
            check(runCatching { validateServerOrigin(origin, cleartext) }.isFailure) {
                "Expected $origin to be rejected"
            }
        }
    }
}

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation(libs.androidx.activity.compose)
    // Play Services Wearable still exposes Fragment 1.1 transitively; Activity Result requires 1.3+.
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.material3)
    implementation(libs.androidx.wear.compose.navigation)
    implementation(libs.google.play.services.wearable)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.wear.tiles)
    implementation(libs.androidx.wear.protolayout)
    implementation(libs.androidx.wear.protolayout.material3)
    implementation(libs.androidx.wear.watchface.complications.data.source.ktx)

    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit4)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    kapt(libs.androidx.room.compiler)
}

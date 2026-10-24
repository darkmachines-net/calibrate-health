/** Runs the existing Detekt documentation rules over authored watch and phone-bridge Kotlin. */
repositories { mavenCentral() }

val detekt by configurations.creating
dependencies {
    detekt("io.gitlab.arturbosch.detekt:detekt-cli:1.23.8:all") { isTransitive = false }
}
dependencyLocking {
    lockAllConfigurations()
    lockMode.set(org.gradle.api.artifacts.dsl.LockMode.STRICT)
}

tasks.register<JavaExec>("lint") {
    description = "Require file overviews and public function KDoc with Detekt."
    classpath = detekt
    mainClass.set("io.gitlab.arturbosch.detekt.cli.Main")
    workingDir = rootDir
    args(
        "--input", "../../wear,../../mobile/modules/wear-pairing/android,.",
        "--excludes", "**/build/**,**/.gradle/**",
        "--config", "detekt.yml",
        "--report", "xml:build/reports/documentation.xml"
    )
}

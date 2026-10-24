# Kotlin documentation lint

Run `npm run lint:kotlin` from the repository root with Java 17 or newer.
The existing Wear Gradle wrapper runs this isolated tool project; Android SDK,
application dependencies, and signing credentials are unnecessary.

Detekt's `UndocumentedPublicFunction` requires KDoc on public functions, including
nested APIs. Overrides inherit the declaration's contract. Its built-in
`AbsentOrWrongFileLicense` rule uses a regex to require a descriptive KDoc block
at the beginning of every authored Kotlin source or Gradle Kotlin script.
Generated build output is excluded. No baseline suppresses missing documentation.

The pinned standalone CLI has its own dependency lock and checksum verification,
so adding documentation lint does not change either application's dependency graph.
Update the pinned dependency, lock, and independently checked verification metadata
together when upgrading Detekt.

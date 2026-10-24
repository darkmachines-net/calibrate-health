/** Watch/server contract compatibility and actionable upgrade-required responses. */

package app.calibratehealth.wear.network

import app.calibratehealth.wear.BuildConfig

internal object WearClientCompatibility {
    const val PLATFORM_HEADER = "X-Calibrate-Client-Platform"
    const val VERSION_HEADER = "X-Calibrate-Client-Version"
    const val MINIMUM_VERSION_HEADER = "X-Calibrate-Minimum-Client-Version"
    const val PLATFORM = "wear_os"
    const val UPGRADE_REQUIRED_CODE = "CLIENT_UPGRADE_REQUIRED"

    private val VERSION_PATTERN = Regex("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$")

    fun headers(version: String = BuildConfig.VERSION_NAME): Map<String, String> {
        require(version.length <= 64 && VERSION_PATTERN.matches(version)) { "Invalid Wear client version." }
        return mapOf(PLATFORM_HEADER to PLATFORM, VERSION_HEADER to version)
    }

    /** Treat every HTTP 426 as an update boundary, but trust body fields only after strict validation. */
    fun parseUpgradeRequired(
        status: Int,
        body: String,
        minimumHeader: String? = null
    ): WearUpgradeRequirement? {
        if (status != 426) return null
        val headerMinimum = minimumHeader?.takeIf { it.length <= 64 && VERSION_PATTERN.matches(it) }
        val parsed = runCatching {
            val root = StrictJson.parse(body).requireObject()
            val code = root.requiredString("code")
            val platform = root.requiredString("platform")
            val minimum = root.requiredString("minimum_supported_version")
            val message = root.requiredString("message")
            require(code == UPGRADE_REQUIRED_CODE && platform == PLATFORM)
            require(minimum.length <= 64 && VERSION_PATTERN.matches(minimum))
            require(message.isNotBlank() && message.length <= 180)
            WearUpgradeRequirement(minimum, message)
        }.getOrNull()
        if (parsed != null) return parsed

        return WearUpgradeRequirement(
            minimumVersion = headerMinimum,
            message = headerMinimum?.let { "Update Calibrate on this watch to version $it or newer." }
                ?: "Update Calibrate on this watch to continue."
        )
    }
}

internal data class WearUpgradeRequirement(
    val minimumVersion: String?,
    val message: String
)

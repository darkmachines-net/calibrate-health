/** Exposes the validated server origin and build variant baked into the watch binary. */

package app.calibratehealth.wear

/** Public build-time bootstrap configuration; credentials never belong in this value. */
data class WearServerConfig(
    val defaultServerUrl: String,
    val buildVariant: String
) {
    companion object {
        /** Reads the validated server origin and variant baked into BuildConfig. */
        fun fromBuildConfig(): WearServerConfig = WearServerConfig(
            defaultServerUrl = BuildConfig.DEFAULT_SERVER_URL,
            buildVariant = BuildConfig.BUILD_TYPE
        )
    }
}

/** Regression tests and fixtures for Wear Client Compatibility. */

package app.calibratehealth.wear.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearClientCompatibilityTest {
    /** Verifies that identity headers accept release and internal semantic versions. */
    @Test
    fun `identity headers accept release and internal semantic versions`() {
        assertEquals(
            mapOf(
                "X-Calibrate-Client-Platform" to "wear_os",
                "X-Calibrate-Client-Version" to "0.1.0-internal"
            ),
            WearClientCompatibility.headers("0.1.0-internal")
        )
        assertTrue(runCatching { WearClientCompatibility.headers("development") }.isFailure)
    }

    /** Verifies that strict upgrade response retains the server floor and safe message. */
    @Test
    fun `strict upgrade response retains the server floor and safe message`() {
        val requirement = WearClientCompatibility.parseUpgradeRequired(
            426,
            """{"message":"Update Calibrate for Wear OS to version 0.2.0 or newer to continue.","code":"CLIENT_UPGRADE_REQUIRED","platform":"wear_os","current_version":"0.1.0","minimum_supported_version":"0.2.0","retryable":false}"""
        )
        assertEquals("0.2.0", requirement?.minimumVersion)
        assertEquals(
            "Update Calibrate for Wear OS to version 0.2.0 or newer to continue.",
            requirement?.message
        )
    }

    /** Verifies that malformed 426 uses only a validated minimum header and non-426 is ignored. */
    @Test
    fun `malformed 426 uses only a validated minimum header and non-426 is ignored`() {
        val fallback = WearClientCompatibility.parseUpgradeRequired(426, "<html>", "0.3.0")
        assertEquals("0.3.0", fallback?.minimumVersion)
        assertEquals("Update Calibrate on this watch to version 0.3.0 or newer.", fallback?.message)
        assertNull(WearClientCompatibility.parseUpgradeRequired(500, "{}", "0.3.0"))
    }
}

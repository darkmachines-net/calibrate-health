/** Regression tests and fixtures for Wear Pairing Http Client. */

package app.calibratehealth.wear.pairing

import app.calibratehealth.wear.network.WatchHttpResponse
import app.calibratehealth.wear.network.WatchHttpTransport
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearPairingHttpClientTest {
    /** Verifies that pairing exchange uses the injected phone-first http transport. */
    @Test
    fun `pairing exchange uses the injected phone-first HTTP transport`() = runBlocking {
        var requestPath = ""
        var platformHeader = ""
        val client = WearPairingHttpClient(
            transport = WatchHttpTransport { request ->
                requestPath = request.url
                platformHeader = request.headers.getValue("X-Calibrate-Client-Platform")
                WatchHttpResponse(
                    status = 200,
                    headers = mapOf("Content-Type" to "application/json"),
                    body = """{"user":{"id":7},"access_token":"access","refresh_token":"refresh","access_expires_at":"2099-07-11T02:00:00Z","refresh_expires_at":"2099-08-11T02:00:00Z"}"""
                )
            },
            maxTransportAttempts = 1
        )

        val session = client.exchange(
            PairingExchangeRequest(
                pairingToken = "pairing-token",
                serverOrigin = "https://health.example.com",
                watchDeviceId = "watch-7",
                exchangeId = "exchange-id",
                challengeSignature = "signature"
            )
        )

        assertEquals("https://health.example.com/auth/mobile/wear/pair", requestPath)
        assertEquals("wear_os", platformHeader)
        assertEquals(7, session.userId)
        assertEquals("watch-7", session.watchDeviceId)
        assertTrue(session.accessExpiresAtEpochMs > Instant.now().toEpochMilli())
    }
}

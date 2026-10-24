/** Regression tests and fixtures for Wear Pairing Protocol. */

package app.calibratehealth.wear.pairing

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class WearPairingProtocolTest {
    private val now = Instant.parse("2026-07-11T20:00:00Z").toEpochMilli()
    private val origin = "https://health.example.com"

    /** Verifies that invite parser binds request to exact build origin and short lifetime. */
    @Test
    fun `invite parser binds request to exact build origin and short lifetime`() {
        val fields = PairingFields(
            kind = "phone_pairing_invite",
            requestId = "b48ae280-4d9d-43d8-99cb-59c8c04ff766",
            protocolVersion = 1,
            serverOrigin = origin,
            issuedAt = "2026-07-11T20:00:00Z",
            expiresAt = "2026-07-11T20:05:00Z"
        )

        assertNotNull(parsePhonePairingInvite(fields, origin, now))
        assertNull(parsePhonePairingInvite(fields.copy(serverOrigin = "https://other.example.com"), origin, now))
        assertNull(parsePhonePairingInvite(fields.copy(expiresAt = "2026-07-11T20:10:00Z"), origin, now))
        assertNull(parsePhonePairingInvite(fields, origin, now + MAX_PAIRING_WINDOW_MS))
    }

    /** Verifies that credential parser requires request node origin and device correlation. */
    @Test
    fun `credential parser requires request node origin and device correlation`() {
        val pending = pendingInvite()
        val fields = PairingFields(
            requestId = pending.requestId,
            protocolVersion = 1,
            serverOrigin = origin,
            expiresAt = "2026-07-11T20:04:00Z",
            pairingToken = "one-time-token",
            watchDeviceId = pending.watchDeviceId,
            challenge = "server-challenge"
        )

        assertNotNull(parseWearPairingCredential(fields, pending, "phone-node", now))
        assertNull(parseWearPairingCredential(fields, pending, "other-node", now))
        assertNull(parseWearPairingCredential(fields.copy(requestId = "other-request"), pending, "phone-node", now))
        assertNull(parseWearPairingCredential(fields.copy(watchDeviceId = "other-watch"), pending, "phone-node", now))
        assertTrue(isCorrelated(pending, pending.requestId, "phone-node", origin))
    }

    /** Verifies that account disconnect requires the retained phone account and a fresh command. */
    @Test
    fun `account disconnect requires the retained phone account and a fresh command`() {
        val fields = PairingFields(
            kind = "phone_account_deleted",
            requestId = "disconnect-request",
            protocolVersion = 1,
            serverOrigin = origin,
            userId = 7,
            watchDeviceId = "watch-id",
            issuedAtEpochMs = now
        )
        fun parse(value: PairingFields = fields, nodeId: String = "phone-node", at: Long = now) =
            parsePhoneAccountDisconnect(value, nodeId, "phone-node", origin, 7, "watch-id", at)

        assertNotNull(parse())
        assertNull(parse(fields.copy(requestId = null)))
        assertNull(parse(nodeId = "other-phone"))
        assertNull(parse(fields.copy(userId = 8)))
        assertNull(parse(fields.copy(serverOrigin = "https://other.example.com")))
        assertNull(parse(fields.copy(watchDeviceId = "other-watch")))
        assertNull(parse(at = now + MAX_PAIRING_WINDOW_MS + 1))
    }

    /** Verifies that account disconnect result is a positive correlated cleanup acknowledgement. */
    @Test
    fun `account disconnect result is a positive correlated cleanup acknowledgement`() {
        assertEquals(
            "{\"kind\":\"watch_account_disconnected\",\"request_id\":\"disconnect-request\"," +
                "\"protocol_version\":1,\"server_origin\":\"https://health.example.com\"," +
                "\"user_id\":7,\"watch_device_id\":\"watch-id\",\"ok\":true}",
            buildAccountDisconnectResult(
                PhoneAccountDisconnect(
                    requestId = "disconnect-request",
                    serverOrigin = origin,
                    userId = 7,
                    watchDeviceId = "watch-id",
                    issuedAtEpochMs = now
                )
            )
        )
    }

    /** Verifies that pairing results report both success and bounded failure to the phone. */
    @Test
    fun `pairing results report both success and bounded failure to the phone`() {
        val pending = pendingInvite()
        assertEquals(
            "{\"ok\":true,\"request_id\":\"b48ae280-4d9d-43d8-99cb-59c8c04ff766\"," +
                "\"protocol_version\":1,\"server_origin\":\"https://health.example.com\"," +
                "\"watch_device_id\":\"watch-id\",\"watch_device_name\":\"Galaxy Watch\"}",
            buildPairingResult(pending)
        )
        assertEquals(
            "{\"ok\":false,\"request_id\":\"b48ae280-4d9d-43d8-99cb-59c8c04ff766\"," +
                "\"protocol_version\":1,\"server_origin\":\"https://health.example.com\"," +
                "\"watch_device_id\":\"watch-id\"," +
                "\"message\":\"Pairing response was unavailable. Start pairing again.\"}",
            buildPairingResult(pending, " Pairing response was unavailable. Start pairing again. ")
        )
    }

    /** Verifies that signing payload exactly matches backend protocol bytes. */
    @Test
    fun `signing payload exactly matches backend protocol bytes`() {
        val payload = buildPairingSigningPayload(
            origin,
            "watch-id",
            "0a253c17-2e4c-44a5-aa46-a67fa8b8a9c4",
            "challenge"
        )
        assertArrayEquals(
            (
                "calibrate-wear-pairing-v1\nhttps://health.example.com\nwatch-id\n" +
                    "0a253c17-2e4c-44a5-aa46-a67fa8b8a9c4\nchallenge"
                ).toByteArray(Charsets.UTF_8),
            payload
        )
    }

    /** Verifies that exchange url accepts only an origin and appends fixed api route. */
    @Test
    fun `exchange URL accepts only an origin and appends fixed API route`() {
        assertEquals(
            "https://health.example.com/auth/mobile/wear/pair",
            buildPairingExchangeUrl(origin)
        )
        assertEquals(
            "http://10.0.2.2:3000/auth/mobile/wear/pair",
            buildPairingExchangeUrl("http://10.0.2.2:3000")
        )
        assertTrue(runCatching { buildPairingExchangeUrl("https://health.example.com/path") }.isFailure)
        assertTrue(runCatching { buildPairingExchangeUrl("https://health.example.com?token=x") }.isFailure)
        assertTrue(runCatching { buildPairingExchangeUrl("http://health.example.com") }.isFailure)
    }

    private fun pendingInvite() = PendingPairingInvite(
        requestId = "b48ae280-4d9d-43d8-99cb-59c8c04ff766",
        phoneNodeId = "phone-node",
        serverOrigin = origin,
        expiresAtEpochMs = now + MAX_PAIRING_WINDOW_MS,
        watchDeviceId = "watch-id",
        watchDeviceName = "Galaxy Watch",
        keyAlias = "test-key"
    )
}

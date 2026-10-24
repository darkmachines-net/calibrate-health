/** Regression tests and fixtures for Wear Pairing Protocol. */

package app.calibratehealth.wearpairing

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearPairingProtocolTest {
    /** Verifies that allows the exact account cleanup request and result paths. */
    @Test
    fun `allows the exact account cleanup request and result paths`() {
        assertTrue(WearPairingProtocol.isAllowed(WearPairingProtocol.ACCOUNT_DISCONNECT))
        assertTrue(WearPairingProtocol.isAllowed(WearPairingProtocol.ACCOUNT_DISCONNECT_RESULT))
        assertFalse(WearPairingProtocol.isAllowed("${WearPairingProtocol.ACCOUNT_DISCONNECT_RESULT}/other"))
    }

    /** Verifies that keeps native network relay paths out of the java script bridge. */
    @Test
    fun `keeps native network relay paths out of the JavaScript bridge`() {
        assertFalse(WearPairingProtocol.isAllowed(WearPairingProtocol.NETWORK_REQUEST))
        assertFalse(WearPairingProtocol.isAllowed(WearPairingProtocol.NETWORK_RESPONSE))
        assertFalse(WearPairingProtocol.isAllowed("${WearPairingProtocol.NETWORK_REQUEST}/other"))
    }
}

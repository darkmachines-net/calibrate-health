/** Regression tests and fixtures for Wear Data Layer Contract. */

package app.calibratehealth.wear

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearDataLayerContractTest {
    /** Verifies that publishes stable pairing capability. */
    @Test
    fun `publishes stable pairing capability`() {
        assertTrue(WearDataLayerContract.PAIRING_CAPABILITY == "calibrate_wear_pairing_v1")
    }

    /** Verifies that accepts only versioned coordination paths. */
    @Test
    fun `accepts only versioned coordination paths`() {
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.PAIR_HELLO))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.PAIR_CREDENTIAL))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.PAIR_RESULT))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.SYNC_INVALIDATE))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.CONTINUE_ON_PHONE))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.ACCOUNT_DISCONNECT))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.ACCOUNT_DISCONNECT_RESULT))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.NETWORK_REQUEST))
        assertTrue(WearDataLayerContract.supports(WearDataLayerContract.NETWORK_RESPONSE))
        assertFalse(WearDataLayerContract.supports("/calibrate/v1/summary"))
        assertFalse(WearDataLayerContract.supports("/other/v1/summary"))
    }
}

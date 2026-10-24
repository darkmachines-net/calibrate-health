/** Versioned pairing message validation, identity binding, and bounded serialization. */

package app.calibratehealth.wearpairing

internal object WearPairingProtocol {
    const val CAPABILITY = "calibrate_wear_pairing_v1"
    const val PAIR_HELLO = "/calibrate/v1/pair/hello"
    const val PAIR_CREDENTIAL = "/calibrate/v1/pair/credential"
    const val PAIR_RESULT = "/calibrate/v1/pair/result"
    const val SYNC_INVALIDATE = "/calibrate/v1/sync/invalidate"
    const val CONTINUE_ON_PHONE = "/calibrate/v1/continue-on-phone"
    const val ACCOUNT_DISCONNECT = "/calibrate/v1/account/disconnect"
    const val ACCOUNT_DISCONNECT_RESULT = "/calibrate/v1/account/disconnect-result"
    const val NETWORK_REQUEST = "/calibrate/v1/network/request"
    const val NETWORK_RESPONSE = "/calibrate/v1/network/response"
    const val MAX_MESSAGE_BYTES = 32 * 1024

    private val allowedPaths = setOf(
        PAIR_HELLO,
        PAIR_CREDENTIAL,
        PAIR_RESULT,
        SYNC_INVALIDATE,
        CONTINUE_ON_PHONE,
        ACCOUNT_DISCONNECT,
        ACCOUNT_DISCONNECT_RESULT
    )

    fun isAllowed(path: String): Boolean = path in allowedPaths
}

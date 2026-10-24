/** Allowlisted versioned paths for phone/watch coordination and bounded network relay. */

package app.calibratehealth.wear

/** Versioned coordination and relay paths shared by the phone and watch Data Layer adapters. */
object WearDataLayerContract {
    const val PAIRING_CAPABILITY = "calibrate_wear_pairing_v1"
    const val PAIR_HELLO = "/calibrate/v1/pair/hello"
    const val PAIR_CREDENTIAL = "/calibrate/v1/pair/credential"
    const val PAIR_RESULT = "/calibrate/v1/pair/result"
    const val SYNC_INVALIDATE = "/calibrate/v1/sync/invalidate"
    const val CONTINUE_ON_PHONE = "/calibrate/v1/continue-on-phone"
    const val ACCOUNT_DISCONNECT = "/calibrate/v1/account/disconnect"
    const val ACCOUNT_DISCONNECT_RESULT = "/calibrate/v1/account/disconnect-result"
    const val NETWORK_REQUEST = "/calibrate/v1/network/request"
    const val NETWORK_RESPONSE = "/calibrate/v1/network/response"

    /** Accepts only the explicitly versioned Data Layer coordination and relay paths. */
    fun supports(path: String): Boolean =
        path == PAIR_HELLO ||
            path == PAIR_CREDENTIAL ||
            path == PAIR_RESULT ||
            path == SYNC_INVALIDATE ||
            path == CONTINUE_ON_PHONE ||
            path == ACCOUNT_DISCONNECT ||
            path == ACCOUNT_DISCONNECT_RESULT ||
            path == NETWORK_REQUEST ||
            path == NETWORK_RESPONSE
}

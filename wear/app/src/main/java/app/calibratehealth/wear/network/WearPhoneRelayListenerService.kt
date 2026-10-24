/** Receives versioned phone-relay responses and routes them to pending watch requests. */

package app.calibratehealth.wear.network

import app.calibratehealth.wear.WearDataLayerContract
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/** Completes in-process relay waiters without persisting health payloads or credentials. */
class WearPhoneRelayListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != WearDataLayerContract.NETWORK_RESPONSE) return
        PhoneRelayResponseInbox.append(event.sourceNodeId, event.data)
    }
}

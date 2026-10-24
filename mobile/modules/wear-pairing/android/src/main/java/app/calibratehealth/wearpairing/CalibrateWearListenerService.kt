/** Phone-side intake of bounded pairing, handoff, and relay messages from watch nodes. */

package app.calibratehealth.wearpairing

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/** Relays Watch HTTP natively and durably queues the remaining coordination messages for JavaScript. */
class CalibrateWearListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path == WearPairingProtocol.NETWORK_REQUEST) {
            WearNetworkRelay.dispatch(applicationContext, event.sourceNodeId, event.data)
            return
        }
        WearPairingInbox.append(applicationContext, event.sourceNodeId, event.path, event.data)
    }
}

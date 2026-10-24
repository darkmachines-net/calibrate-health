/** Expo bridge exposing watch discovery, pairing, and account-bound coordination to the shared phone client. */

package app.calibratehealth.wearpairing

import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.tasks.await

/** Narrow Expo bridge for capability discovery and short-lived pairing coordination. */
class CalibrateWearPairingModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("CalibrateWearPairing")

        // The explicit zero-argument arrow selects Expo Modules' suspend overload;
        // omitting it is ambiguous with the one-argument Coroutine builder.
        AsyncFunction("getPairingNodes") Coroutine { ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            val capability = Wearable.getCapabilityClient(context)
                .getCapability(WearPairingProtocol.CAPABILITY, CapabilityClient.FILTER_REACHABLE)
                .await()
            capability.nodes.map { node ->
                mapOf(
                    "id" to node.id,
                    "displayName" to node.displayName,
                    "isNearby" to node.isNearby
                )
            }
        }

        AsyncFunction("sendMessage") Coroutine { nodeId: String, path: String, payload: String ->
            require(WearPairingProtocol.isAllowed(path)) { "Unsupported Wear pairing path" }
            val bytes = payload.toByteArray(Charsets.UTF_8)
            require(bytes.size <= WearPairingProtocol.MAX_MESSAGE_BYTES) { "Wear pairing payload is too large" }
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            Wearable.getMessageClient(context).sendMessage(nodeId, path, bytes).await()
        }

        Function("prepareNetworkRelay") { nodeId: String, serverOrigin: String, requestId: String, expiresAtEpochMs: Double ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            require(expiresAtEpochMs.isFinite() && expiresAtEpochMs % 1.0 == 0.0) {
                "Wear relay expiry must be an integer epoch millisecond value"
            }
            WearNetworkRelayBindingStore(context).prepare(
                nodeId,
                serverOrigin,
                requestId,
                expiresAtEpochMs.toLong()
            )
        }

        Function("commitNetworkRelay") { nodeId: String, serverOrigin: String, requestId: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearNetworkRelayBindingStore(context).commit(nodeId, serverOrigin, requestId)
        }

        Function("restoreNetworkRelay") { nodeId: String, serverOrigin: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearNetworkRelayBindingStore(context).restore(nodeId, serverOrigin)
        }

        Function("clearPendingNetworkRelay") { nodeId: String, serverOrigin: String, requestId: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearNetworkRelayBindingStore(context).clearPending(nodeId, serverOrigin, requestId)
        }

        Function("clearNetworkRelay") { nodeId: String, serverOrigin: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearNetworkRelayBindingStore(context).clearActive(nodeId, serverOrigin)
        }

        Function("listMessages") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearPairingInbox.list(context)
        }

        Function("acknowledgeMessages") { messageIds: List<String> ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("Android context is unavailable")
            WearPairingInbox.acknowledge(context, messageIds)
        }
    }
}

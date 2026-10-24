/** Durable authorization binding for the exact paired watch node and phone account. */

package app.calibratehealth.wearpairing

import android.content.Context
import org.json.JSONObject
import java.net.URI

internal data class WearNetworkRelayBinding(
    val nodeId: String,
    val serverOrigin: String
)

internal data class PendingWearNetworkRelayBinding(
    val nodeId: String,
    val serverOrigin: String,
    val requestId: String,
    val expiresAtEpochMs: Long
)

/** Keeps proxy authorization native so the phone can relay while the Expo UI is backgrounded. */
internal class WearNetworkRelayBindingStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun prepare(nodeId: String, serverOrigin: String, requestId: String, expiresAtEpochMs: Long) {
        val pending = PendingWearNetworkRelayBinding(
            nodeId = requireText(nodeId, MAX_NODE_ID_LENGTH, "Wear node ID"),
            serverOrigin = requireCanonicalOrigin(serverOrigin),
            requestId = requireText(requestId, MAX_REQUEST_ID_LENGTH, "Wear request ID"),
            expiresAtEpochMs = expiresAtEpochMs
        )
        val nowEpochMs = System.currentTimeMillis()
        require(pending.expiresAtEpochMs > nowEpochMs) { "Wear relay authorization already expired." }
        require(pending.expiresAtEpochMs - nowEpochMs <= MAX_PENDING_LIFETIME_MS) {
            "Wear relay authorization lasts too long."
        }
        check(preferences.edit().putString(PENDING, encodePending(pending)).commit()) {
            "Unable to persist pending Wear relay authorization."
        }
    }

    @Synchronized
    fun commit(nodeId: String, serverOrigin: String, requestId: String) {
        val expected = PendingWearNetworkRelayBinding(
            nodeId = requireText(nodeId, MAX_NODE_ID_LENGTH, "Wear node ID"),
            serverOrigin = requireCanonicalOrigin(serverOrigin),
            requestId = requireText(requestId, MAX_REQUEST_ID_LENGTH, "Wear request ID"),
            expiresAtEpochMs = Long.MAX_VALUE
        )
        val active = readActive()
        if (active?.nodeId == expected.nodeId && active.serverOrigin == expected.serverOrigin) {
            check(preferences.edit().remove(PENDING).commit()) {
                "Unable to finish the Wear network relay activation."
            }
            return
        }
        val pending = readPending(System.currentTimeMillis())
        require(
            pending != null && pending.nodeId == expected.nodeId &&
                pending.serverOrigin == expected.serverOrigin && pending.requestId == expected.requestId
        ) { "Wear relay completion did not match the pending pairing." }
        val completed = WearNetworkRelayBinding(pending.nodeId, pending.serverOrigin)
        check(preferences.edit().putString(ACTIVE, encodeActive(completed)).remove(PENDING).commit()) {
            "Unable to activate the Wear network relay."
        }
    }

    /** Migrates a pairing created before the native relay existed. */
    @Synchronized
    fun restore(nodeId: String, serverOrigin: String) {
        val active = WearNetworkRelayBinding(
            nodeId = requireText(nodeId, MAX_NODE_ID_LENGTH, "Wear node ID"),
            serverOrigin = requireCanonicalOrigin(serverOrigin)
        )
        check(preferences.edit().putString(ACTIVE, encodeActive(active)).commit()) {
            "Unable to restore the Wear network relay."
        }
    }

    @Synchronized
    fun clearPending(nodeId: String, serverOrigin: String, requestId: String) {
        val pending = readPending(System.currentTimeMillis()) ?: return
        if (
            pending.nodeId == nodeId && pending.serverOrigin == canonicalOrigin(serverOrigin) &&
            pending.requestId == requestId
        ) {
            preferences.edit().remove(PENDING).commit()
        }
    }

    @Synchronized
    fun clearActive(nodeId: String, serverOrigin: String) {
        val active = readActive() ?: return
        if (active.nodeId == nodeId && active.serverOrigin == canonicalOrigin(serverOrigin)) {
            preferences.edit().remove(ACTIVE).commit()
        }
    }

    @Synchronized
    fun isAuthorized(
        nodeId: String,
        serverOrigin: String,
        path: String,
        nowEpochMs: Long = System.currentTimeMillis()
    ): Boolean {
        val origin = canonicalOrigin(serverOrigin) ?: return false
        val active = readActive()
        if (active?.nodeId == nodeId && active.serverOrigin == origin) return true
        if (path != WearNetworkRelayPolicy.PAIRING_EXCHANGE_PATH) return false
        val pending = readPending(nowEpochMs)
        return pending?.nodeId == nodeId && pending.serverOrigin == origin
    }

    private fun readActive(): WearNetworkRelayBinding? {
        val encoded = preferences.getString(ACTIVE, null) ?: return null
        val binding = runCatching {
            val value = JSONObject(encoded)
            WearNetworkRelayBinding(
                nodeId = requireText(value.getString("node_id"), MAX_NODE_ID_LENGTH, "Wear node ID"),
                serverOrigin = requireCanonicalOrigin(value.getString("server_origin"))
            )
        }.getOrNull()
        if (binding != null) return binding
        preferences.edit().remove(ACTIVE).commit()
        return null
    }

    private fun readPending(nowEpochMs: Long): PendingWearNetworkRelayBinding? {
        val encoded = preferences.getString(PENDING, null) ?: return null
        val pending = runCatching {
            val value = JSONObject(encoded)
            PendingWearNetworkRelayBinding(
                nodeId = requireText(value.getString("node_id"), MAX_NODE_ID_LENGTH, "Wear node ID"),
                serverOrigin = requireCanonicalOrigin(value.getString("server_origin")),
                requestId = requireText(value.getString("request_id"), MAX_REQUEST_ID_LENGTH, "Wear request ID"),
                expiresAtEpochMs = value.getLong("expires_at_epoch_ms")
            )
        }.getOrNull()
        if (pending != null && pending.expiresAtEpochMs > nowEpochMs) return pending
        preferences.edit().remove(PENDING).commit()
        return null
    }

    private fun encodeActive(binding: WearNetworkRelayBinding): String = JSONObject()
        .put("node_id", binding.nodeId)
        .put("server_origin", binding.serverOrigin)
        .toString()

    private fun encodePending(binding: PendingWearNetworkRelayBinding): String = JSONObject()
        .put("node_id", binding.nodeId)
        .put("server_origin", binding.serverOrigin)
        .put("request_id", binding.requestId)
        .put("expires_at_epoch_ms", binding.expiresAtEpochMs)
        .toString()

    private fun requireCanonicalOrigin(value: String): String =
        requireNotNull(canonicalOrigin(value)) { "Wear relay server must be a canonical HTTP(S) origin." }

    private fun canonicalOrigin(value: String): String? = runCatching {
        val uri = URI(value)
        require(uri.scheme == "https" || uri.scheme == "http")
        require(uri.isAbsolute && !uri.host.isNullOrBlank())
        require(uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
        require(uri.port == -1 || uri.port in 1..65_535)
        "${uri.scheme}://${uri.rawAuthority}"
    }.getOrNull()?.takeIf { it == value.removeSuffix("/") }

    private fun requireText(value: String, maximumLength: Int, label: String): String {
        val trimmed = value.trim()
        require(trimmed.isNotEmpty() && trimmed.length <= maximumLength) { "$label is invalid." }
        return trimmed
    }

    private companion object {
        const val PREFERENCES = "calibrate_wear_network_relay_v1"
        const val ACTIVE = "active"
        const val PENDING = "pending"
        const val MAX_NODE_ID_LENGTH = 256
        const val MAX_REQUEST_ID_LENGTH = 128
        const val MAX_PENDING_LIFETIME_MS = 5 * 60 * 1000L + 30_000L
    }
}

/** Retains the exact phone node and account identity authorized during watch pairing. */

package app.calibratehealth.wear.pairing

import android.content.Context
import app.calibratehealth.wear.data.security.SecureSession
import org.json.JSONObject

internal data class TrustedPhoneBinding(
    val nodeId: String,
    val serverOrigin: String,
    val userId: Long,
    val watchDeviceId: String
)

internal fun TrustedPhoneBinding.matches(session: SecureSession): Boolean =
    nodeId.isNotBlank() && nodeId.length <= 256 &&
        serverOrigin == session.serverOrigin &&
        userId == session.userId &&
        watchDeviceId == session.watchDeviceId

/** Stores the exact phone node that completed the active server-backed session pairing. */
internal class TrustedPhoneBindingStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun write(binding: TrustedPhoneBinding, session: SecureSession) {
        require(binding.matches(session)) { "Trusted phone binding must match the active Wear session." }
        val encoded = JSONObject()
            .put("node_id", binding.nodeId)
            .put("server_origin", binding.serverOrigin)
            .put("user_id", binding.userId)
            .put("watch_device_id", binding.watchDeviceId)
            .toString()
        check(preferences.edit().putString(BINDING, encoded).commit()) {
            "Unable to persist the trusted phone binding."
        }
    }

    @Synchronized
    fun read(session: SecureSession): TrustedPhoneBinding? {
        val encoded = preferences.getString(BINDING, null) ?: return null
        val binding = runCatching {
            val value = JSONObject(encoded)
            TrustedPhoneBinding(
                nodeId = value.getString("node_id"),
                serverOrigin = value.getString("server_origin"),
                userId = value.getLong("user_id"),
                watchDeviceId = value.getString("watch_device_id")
            )
        }.getOrNull()
        if (binding?.matches(session) == true) return binding
        preferences.edit().remove(BINDING).commit()
        return null
    }

    fun clear() {
        check(preferences.edit().remove(BINDING).commit()) {
            "Unable to clear the trusted phone binding."
        }
    }

    private companion object {
        const val PREFERENCES = "calibrate_wear_trusted_phone_v1"
        const val BINDING = "binding"
    }
}

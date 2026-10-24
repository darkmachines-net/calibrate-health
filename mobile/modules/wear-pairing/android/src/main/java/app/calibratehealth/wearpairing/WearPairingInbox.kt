/** Phone-side storage and dispatch of bounded watch coordination messages. */

package app.calibratehealth.wearpairing

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Small durable inbox so process death cannot drop a one-time pairing request. */
internal object WearPairingInbox {
    private const val PREFERENCES = "calibrate_wear_pairing_inbox"
    private const val MESSAGES = "messages"
    private const val MAX_MESSAGES = 20

    @Synchronized
    fun append(context: Context, nodeId: String, path: String, payload: ByteArray) {
        if (!WearPairingProtocol.isAllowed(path) || payload.size > WearPairingProtocol.MAX_MESSAGE_BYTES) return
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val current = runCatching { JSONArray(preferences.getString(MESSAGES, "[]")) }.getOrElse { JSONArray() }
        val bounded = JSONArray()
        val first = (current.length() - (MAX_MESSAGES - 1)).coerceAtLeast(0)
        for (index in first until current.length()) bounded.put(current.get(index))
        bounded.put(JSONObject().apply {
            put("id", UUID.randomUUID().toString())
            put("nodeId", nodeId)
            put("path", path)
            put("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
            put("receivedAt", System.currentTimeMillis())
        })
        // Pairing messages carry one-time material, so confirm the disk write before returning.
        check(preferences.edit().putString(MESSAGES, bounded.toString()).commit()) {
            "Unable to persist the Wear pairing inbox"
        }
    }

    @Synchronized
    fun list(context: Context): List<Map<String, Any>> {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val current = runCatching { JSONArray(preferences.getString(MESSAGES, "[]")) }.getOrElse { JSONArray() }
        return buildList {
            for (index in 0 until current.length()) {
                val entry = current.optJSONObject(index) ?: continue
                val decoded = runCatching {
                    String(Base64.decode(entry.getString("payload"), Base64.DEFAULT), Charsets.UTF_8)
                }.getOrNull() ?: continue
                add(mapOf(
                    "id" to entry.getString("id"),
                    "nodeId" to entry.getString("nodeId"),
                    "path" to entry.getString("path"),
                    "payload" to decoded,
                    "receivedAt" to entry.getLong("receivedAt")
                ))
            }
        }
    }

    @Synchronized
    fun acknowledge(context: Context, messageIds: List<String>) {
        if (messageIds.isEmpty()) return
        val acknowledged = messageIds.toSet()
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val current = runCatching { JSONArray(preferences.getString(MESSAGES, "[]")) }.getOrElse { JSONArray() }
        val remaining = JSONArray()
        for (index in 0 until current.length()) {
            val entry = current.optJSONObject(index) ?: continue
            if (entry.optString("id") !in acknowledged) remaining.put(entry)
        }
        check(preferences.edit().putString(MESSAGES, remaining.toString()).commit()) {
            "Unable to persist Wear pairing acknowledgements"
        }
    }
}

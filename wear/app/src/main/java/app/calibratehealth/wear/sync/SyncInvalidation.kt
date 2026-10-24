/** Trusted-phone invalidation intake and scheduling of account-scoped watch refresh. */

package app.calibratehealth.wear.sync

import android.content.Context
import android.content.SharedPreferences
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import app.calibratehealth.wear.WearDataLayerContract
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.pairing.TrustedPhoneBindingStore
import org.json.JSONArray

/** Persists receipt before constrained WorkManager enqueue and recovers its one pending ID. */
internal object SyncInvalidationInbox {
    private const val PREFERENCES = "calibrate_wear_sync_invalidation_v1"
    private const val PENDING = "pending"
    private const val ACCEPTED = "accepted"

    @Synchronized
    fun accept(context: Context, invalidation: SyncInvalidation): Boolean {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val accepted = readAccepted(preferences.getString(ACCEPTED, "[]"))
        if (invalidation.id in accepted) return false
        check(preferences.edit().putString(PENDING, invalidation.id).commit()) {
            "Unable to persist sync invalidation receipt."
        }
        WorkManagerOutboxScheduler(context).scheduleAuthoritativeRefresh()
        return true
    }

    @Synchronized
    fun recover(context: Context): Boolean {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val pending = preferences.getString(PENDING, null)?.takeIf(SYNC_INVALIDATION_ID::matches) ?: return false
        WorkManagerOutboxScheduler(context).scheduleAuthoritativeRefresh()
        return true
    }

    @Synchronized
    fun pendingId(context: Context): String? =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(PENDING, null)
            ?.takeIf(SYNC_INVALIDATION_ID::matches)

    /** A receipt becomes replay-deduplicated only after its authoritative refresh commits. */
    @Synchronized
    fun completeRefresh(context: Context, expectedId: String?) {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val pending = preferences.getString(PENDING, null)?.takeIf(SYNC_INVALIDATION_ID::matches)
        val completed = completedInvalidationIds(
            pendingId = pending,
            capturedId = expectedId,
            acceptedIds = readAccepted(preferences.getString(ACCEPTED, "[]"))
        ) ?: return
        complete(preferences, completed)
    }

    @Synchronized
    fun clear(context: Context) {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        check(preferences.edit().clear().commit()) { "Unable to clear sync invalidation receipts." }
    }

    private fun complete(preferences: SharedPreferences, accepted: List<String>) {
        val encoded = JSONArray().apply {
            accepted.forEach(::put)
        }.toString()
        check(preferences.edit().putString(ACCEPTED, encoded).remove(PENDING).commit()) {
            "Unable to complete sync invalidation receipt."
        }
    }

    private fun readAccepted(encoded: String?): List<String> = runCatching {
        val values = JSONArray(encoded ?: "[]")
        buildList {
            for (index in 0 until values.length()) {
                values.optString(index).takeIf(SYNC_INVALIDATION_ID::matches)?.let(::add)
            }
        }.takeLast(20)
    }.getOrDefault(emptyList())
}

/** Data Layer carries only an authenticated refresh signal; health data remains HTTPS-only. */
class WearSyncInvalidationListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != WearDataLayerContract.SYNC_INVALIDATE) return
        val context = applicationContext
        val session = runCatching { AndroidKeystoreTokenStore(context).read() }.getOrNull() ?: return
        val binding = TrustedPhoneBindingStore(context).read(session) ?: return
        val invalidation = parseSyncInvalidation(
            payload = event.data.toString(Charsets.UTF_8),
            sourceNodeId = event.sourceNodeId,
            expected = ExpectedSyncInvalidationScope(
                phoneNodeId = binding.nodeId,
                serverOrigin = session.serverOrigin,
                userId = session.userId,
                watchDeviceId = session.watchDeviceId
            ),
            nowEpochMs = System.currentTimeMillis()
        ) ?: return
        runCatching { SyncInvalidationInbox.accept(context, invalidation) }
    }
}

/** Durable watch pairing transitions, recovery state, and observable pairing status. */

package app.calibratehealth.wear.pairing

import android.content.Context
import app.calibratehealth.wear.BuildConfig
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.SecureTokenCorruptedException
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet
import app.calibratehealth.wear.sync.SyncInvalidationInbox

sealed interface PairingUiState {
    data object Unpaired : PairingUiState
    data object Pairing : PairingUiState
    data class Paired(
        val userId: Long,
        val serverOrigin: String,
        val confirmationPending: Boolean
    ) : PairingUiState
    data class Error(val message: String) : PairingUiState
    data class UpgradeRequired(val message: String) : PairingUiState
}

internal data class PairingSessionFacts(
    val userId: Long,
    val serverOrigin: String,
    val refreshExpiresAtEpochMs: Long
)

internal const val SESSION_RECOVERY_MESSAGE =
    "Watch sign-in expired. Pair again from Calibrate on your phone; queued changes will be preserved."

/** A locally unexpired token is not a valid fallback after the server has rejected its session. */
internal fun hasUsableFallbackSession(
    isKnownInvalid: Boolean,
    refreshExpiresAtEpochMs: Long?,
    nowEpochMs: Long
): Boolean = !isKnownInvalid && refreshExpiresAtEpochMs?.let { it > nowEpochMs } == true

/** A compatibility-blocked watch must still probe so an in-place update or server rollback can recover. */
internal fun PairingUiState.shouldAttemptForegroundSync(): Boolean =
    this is PairingUiState.Paired || this is PairingUiState.UpgradeRequired

/** Keeps UI precedence and session-expiry behavior testable without Android storage. */
internal fun resolvePairingUiState(
    storedError: String?,
    hasPendingPairing: Boolean,
    session: PairingSessionFacts?,
    confirmationPending: Boolean,
    nowEpochMs: Long
): PairingUiState {
    if (hasPendingPairing) return PairingUiState.Pairing
    if (!storedError.isNullOrBlank()) return PairingUiState.Error(storedError)
    if (session == null) return PairingUiState.Unpaired
    if (session.refreshExpiresAtEpochMs <= nowEpochMs) {
        return PairingUiState.Error(SESSION_RECOVERY_MESSAGE)
    }
    return PairingUiState.Paired(session.userId, session.serverOrigin, confirmationPending)
}

/** Persists only correlation metadata and UI status; one-time credentials never enter preferences. */
internal class PairingStateStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun savePending(pending: PendingPairingInvite) {
        val json = JSONObject()
            .put("request_id", pending.requestId)
            .put("phone_node_id", pending.phoneNodeId)
            .put("server_origin", pending.serverOrigin)
            .put("expires_at_epoch_ms", pending.expiresAtEpochMs)
            .put("watch_device_id", pending.watchDeviceId)
            .put("watch_device_name", pending.watchDeviceName)
            .put("key_alias", pending.keyAlias)
        check(
            preferences.edit()
                .putString(PENDING_KEY, json.toString())
                .remove(ERROR_KEY)
                .remove(UPGRADE_REQUIRED_KEY)
                .commit()
        ) { "Unable to persist Wear pairing request." }
        PairingStateEvents.notifyChanged()
    }

    @Synchronized
    fun readPending(nowEpochMs: Long = System.currentTimeMillis()): PendingPairingInvite? {
        val encoded = preferences.getString(PENDING_KEY, null) ?: return null
        val pending = runCatching {
            val json = JSONObject(encoded)
            PendingPairingInvite(
                requestId = json.getString("request_id"),
                phoneNodeId = json.getString("phone_node_id"),
                serverOrigin = json.getString("server_origin"),
                expiresAtEpochMs = json.getLong("expires_at_epoch_ms"),
                watchDeviceId = json.getString("watch_device_id"),
                watchDeviceName = json.getString("watch_device_name"),
                keyAlias = json.getString("key_alias")
            )
        }.getOrNull()
        if (
            pending == null || pending.expiresAtEpochMs <= nowEpochMs ||
            pending.serverOrigin != BuildConfig.DEFAULT_SERVER_URL ||
            pending.requestId.isBlank() || pending.requestId.length > 128 ||
            pending.phoneNodeId.isBlank() || pending.phoneNodeId.length > 256 ||
            pending.watchDeviceId.isBlank() || pending.watchDeviceId.length > 128 ||
            pending.watchDeviceName.length > 120 ||
            pending.keyAlias.isBlank() || pending.keyAlias.length > 128
        ) {
            pending?.let { WearPairingKeyManager().deleteOwned(it.keyAlias) }
            preferences.edit().remove(PENDING_KEY).commit()
            return null
        }
        return pending
    }

    /** Atomically consumes the request before exchange so a lost response cannot replay its credential. */
    @Synchronized
    fun consumePending(expected: PendingPairingInvite): PendingPairingInvite? {
        val current = readPending()
        if (current != expected) return null
        check(preferences.edit().remove(PENDING_KEY).remove(ERROR_KEY).commit()) {
            "Unable to consume Wear pairing request."
        }
        PairingStateEvents.notifyChanged()
        return current
    }

    @Synchronized
    fun clearPending() {
        readPending()?.let { WearPairingKeyManager().deleteOwned(it.keyAlias) }
        preferences.edit().remove(PENDING_KEY).commit()
        PairingStateEvents.notifyChanged()
    }

    @Synchronized
    fun setError(message: String) {
        val bounded = message.trim().take(180).ifEmpty { "Pairing failed. Start pairing again on your phone." }
        readPending()?.let { WearPairingKeyManager().deleteOwned(it.keyAlias) }
        val nowEpochMs = System.currentTimeMillis()
        val refreshExpiresAtEpochMs = try {
            AndroidKeystoreTokenStore(appContext).read()
                ?.refreshExpiresAtEpochMs
        } catch (_: SecureTokenCorruptedException) {
            null
        }
        val hasUsableSession = hasUsableFallbackSession(
            isKnownInvalid = preferences.getBoolean(SESSION_INVALID_KEY, false),
            refreshExpiresAtEpochMs = refreshExpiresAtEpochMs,
            nowEpochMs = nowEpochMs
        )
        // A replacement attempt must not disable the still-valid session it was meant to supersede.
        val editor = preferences.edit()
            .remove(PENDING_KEY)
            .remove(UPGRADE_REQUIRED_KEY)
        if (hasUsableSession) {
            editor.remove(ERROR_KEY)
        } else {
            editor.putString(ERROR_KEY, bounded)
        }
        check(
            editor.commit()
        ) {
            "Unable to persist Wear pairing error."
        }
        PairingStateEvents.notifyChanged()
    }

    /** Marks revoked/auth-required recovery without destroying credentials, cache, or queued work. */
    @Synchronized
    fun setSessionInvalid(message: String) {
        // A newly accepted invite owns recovery now; do not let a late worker response obscure it.
        if (readPending() != null) return
        // Local disconnect clears credentials first; a late worker must not turn Unpaired into Error.
        val sessionAbsent = try {
            AndroidKeystoreTokenStore(appContext).read() == null
        } catch (_: SecureTokenCorruptedException) {
            false
        }
        if (sessionAbsent) return
        val bounded = message.trim().take(180).ifEmpty { SESSION_RECOVERY_MESSAGE }
        check(
            preferences.edit()
                .remove(UPGRADE_REQUIRED_KEY)
                .putString(ERROR_KEY, bounded)
                .putBoolean(SESSION_INVALID_KEY, true)
                .commit()
        ) {
            "Unable to persist Wear session recovery state."
        }
        PairingStateEvents.notifyChanged()
    }

    /** Preserve the paired session and cache while making an incompatible build unmistakable in the UI. */
    @Synchronized
    fun setUpgradeRequired(message: String) {
        if (readPending() != null) return
        val bounded = message.trim().take(180).ifEmpty { "Update Calibrate on this watch to continue." }
        check(
            preferences.edit()
                .remove(ERROR_KEY)
                .putString(UPGRADE_REQUIRED_KEY, bounded)
                .commit()
        ) { "Unable to persist Wear compatibility state." }
        PairingStateEvents.notifyChanged()
    }

    fun clearError() {
        preferences.edit()
            .remove(ERROR_KEY)
            .remove(UPGRADE_REQUIRED_KEY)
            .remove(SESSION_INVALID_KEY)
            .commit()
        PairingStateEvents.notifyChanged()
    }

    /** Clear only a proven-resolved compatibility block without hiding an unrelated pairing error. */
    @Synchronized
    fun clearUpgradeRequired() {
        if (!preferences.contains(UPGRADE_REQUIRED_KEY)) return
        check(preferences.edit().remove(UPGRADE_REQUIRED_KEY).commit()) {
            "Unable to clear Wear compatibility state."
        }
        PairingStateEvents.notifyChanged()
    }

    fun savePendingResult(result: PendingPairingResult) {
        val json = JSONObject()
            .put("request_id", result.requestId)
            .put("phone_node_id", result.phoneNodeId)
            .put("server_origin", result.serverOrigin)
            .put("expires_at_epoch_ms", result.expiresAtEpochMs)
            .put("watch_device_id", result.watchDeviceId)
            .put("payload", result.payload)
        check(preferences.edit().putString(PENDING_RESULT_KEY, json.toString()).commit()) {
            "Unable to queue phone pairing confirmation."
        }
        PairingStateEvents.notifyChanged()
    }

    fun readPendingResult(nowEpochMs: Long = System.currentTimeMillis()): PendingPairingResult? {
        val encoded = preferences.getString(PENDING_RESULT_KEY, null) ?: return null
        val result = runCatching {
            val json = JSONObject(encoded)
            PendingPairingResult(
                requestId = json.getString("request_id"),
                phoneNodeId = json.getString("phone_node_id"),
                serverOrigin = json.getString("server_origin"),
                expiresAtEpochMs = json.getLong("expires_at_epoch_ms"),
                watchDeviceId = json.getString("watch_device_id"),
                payload = json.getString("payload")
            )
        }.getOrNull()
        if (
            result == null || result.expiresAtEpochMs <= nowEpochMs ||
            result.serverOrigin != BuildConfig.DEFAULT_SERVER_URL ||
            result.requestId.isBlank() || result.requestId.length > 128 ||
            result.phoneNodeId.isBlank() || result.phoneNodeId.length > 256 ||
            result.watchDeviceId.isBlank() || result.watchDeviceId.length > 128 ||
            result.payload.isBlank() || result.payload.toByteArray(Charsets.UTF_8).size > MAX_PAIRING_MESSAGE_BYTES
        ) {
            preferences.edit().remove(PENDING_RESULT_KEY).commit()
            return null
        }
        return result
    }

    fun clearPendingResult() {
        preferences.edit().remove(PENDING_RESULT_KEY).commit()
        PairingStateEvents.notifyChanged()
    }

    /** Removes only watch-local pairing metadata; server and other device sessions are untouched. */
    @Synchronized
    fun clearLocalPairingState() {
        readPending()?.let { WearPairingKeyManager().deleteOwned(it.keyAlias) }
        check(
            preferences.edit()
                .remove(PENDING_KEY)
                .remove(PENDING_RESULT_KEY)
                .remove(ERROR_KEY)
                .remove(UPGRADE_REQUIRED_KEY)
                .remove(SESSION_INVALID_KEY)
                .commit()
        ) { "Unable to clear local Wear pairing state." }
        TrustedPhoneBindingStore(appContext).clear()
        SyncInvalidationInbox.clear(appContext)
        PairingStateEvents.notifyChanged()
    }

    fun currentUiState(): PairingUiState {
        val nowEpochMs = System.currentTimeMillis()
        val upgradeRequired = preferences.getString(UPGRADE_REQUIRED_KEY, null)
        if (!upgradeRequired.isNullOrBlank()) return PairingUiState.UpgradeRequired(upgradeRequired)
        val error = preferences.getString(ERROR_KEY, null)
            ?: SESSION_RECOVERY_MESSAGE.takeIf { preferences.getBoolean(SESSION_INVALID_KEY, false) }
        val hasPendingPairing = readPending(nowEpochMs) != null
        if (!error.isNullOrBlank() || hasPendingPairing) {
            return resolvePairingUiState(error, hasPendingPairing, null, false, nowEpochMs)
        }
        val session = try {
            AndroidKeystoreTokenStore(appContext).read()
        } catch (error: SecureTokenCorruptedException) {
            return PairingUiState.Error("Stored pairing is unreadable. Pair again from your phone.")
        }
        return resolvePairingUiState(
            storedError = error,
            hasPendingPairing = hasPendingPairing,
            session = session?.let {
                PairingSessionFacts(it.userId, it.serverOrigin, it.refreshExpiresAtEpochMs)
            },
            confirmationPending = session != null && readPendingResult(nowEpochMs) != null,
            nowEpochMs = nowEpochMs
        )
    }

    companion object {
        private const val PREFERENCES_NAME = "calibrate_wear_pairing_v1"
        private const val PENDING_KEY = "pending_invite"
        private const val PENDING_RESULT_KEY = "pending_result"
        private const val ERROR_KEY = "pairing_error"
        private const val UPGRADE_REQUIRED_KEY = "client_upgrade_required"
        private const val SESSION_INVALID_KEY = "session_invalid"
    }
}

/** Process-local notification complements durable state for an activity already in the foreground. */
object PairingStateEvents {
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    /** Subscribes a listener to pairing-state changes. */
    fun addListener(listener: () -> Unit) {
        listeners += listener
    }

    /** Removes a previously registered pairing-state listener. */
    fun removeListener(listener: () -> Unit) {
        listeners -= listener
    }

    internal fun notifyChanged() {
        listeners.forEach { it.invoke() }
    }
}

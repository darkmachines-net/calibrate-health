/** Cached reminder state and duplicate-suppressing local delivery when the trusted phone is unreachable. */

package app.calibratehealth.wear.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.calibratehealth.wear.MainActivity
import app.calibratehealth.wear.R
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.pairing.TrustedPhoneBindingStore
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

enum class WearReminderType(val wireValue: String) {
    FOOD("food"),
    WEIGHT("weight");

    companion object {
        /** Maps an allowlisted wire reminder type, returning null for unknown values. */
        fun fromWire(value: String): WearReminderType? = entries.firstOrNull { it.wireValue == value }
    }
}

data class WearReminder(
    val id: Long,
    val type: WearReminderType,
    val localDate: String,
    val createdAtEpochMs: Long
)

data class WearReminderNotification(
    val fingerprint: String,
    val localDate: String,
    val types: Set<WearReminderType>
) {
    val destination: String = if (WearReminderType.FOOD in types) DESTINATION_FOOD else DESTINATION_WEIGHT

    companion object {
        const val DESTINATION_FOOD = "food"
        const val DESTINATION_WEIGHT = "weight"
    }
}

sealed interface WearReminderDecision {
    data class Notify(val notification: WearReminderNotification) : WearReminderDecision
    data object Cancel : WearReminderDecision
    data object None : WearReminderDecision
}

/** Pure policy prevents a local watch alert from competing with a reachable phone reminder. */
object WearReminderPolicy {
    /** Decides whether to cancel, suppress, or post current reminders based on phone reachability, permission, and prior delivery. */
    fun decide(
        reminders: List<WearReminder>,
        phoneReachable: Boolean,
        notificationPermissionGranted: Boolean,
        lastNotifiedFingerprint: String?
    ): WearReminderDecision {
        if (reminders.isEmpty() || phoneReachable) return WearReminderDecision.Cancel
        if (!notificationPermissionGranted) return WearReminderDecision.None
        val newestDate = reminders.maxBy(WearReminder::createdAtEpochMs).localDate
        val current = reminders.filter { it.localDate == newestDate }
        val fingerprint = current.sortedBy(WearReminder::id).joinToString("|") {
            "${it.id}:${it.type.wireValue}:${it.localDate}"
        }
        if (fingerprint == lastNotifiedFingerprint) return WearReminderDecision.None
        return WearReminderDecision.Notify(
            WearReminderNotification(fingerprint, newestDate, current.mapTo(mutableSetOf()) { it.type })
        )
    }
}

/** Private durable state survives worker/process recreation without adding reminder rows to Room. */
class WearReminderStateStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    /** Synchronously replaces the cached allowlisted reminder rows and fails when persistence fails. */
    fun replace(reminders: List<WearReminder>) {
        val encoded = JSONArray().apply {
            reminders.forEach { reminder ->
                put(JSONObject().apply {
                    put("id", reminder.id)
                    put("type", reminder.type.wireValue)
                    put("local_date", reminder.localDate)
                    put("created_at_epoch_ms", reminder.createdAtEpochMs)
                })
            }
        }
        check(preferences.edit().putString(REMINDERS, encoded.toString()).commit()) {
            "Unable to persist Wear reminders."
        }
    }

    /** Reads valid cached reminders, discarding malformed entries or an unreadable payload. */
    fun read(): List<WearReminder> {
        val array = runCatching { JSONArray(preferences.getString(REMINDERS, "[]")) }.getOrElse { return emptyList() }
        return buildList {
            for (index in 0 until array.length()) {
                val value = array.optJSONObject(index) ?: continue
                val type = WearReminderType.fromWire(value.optString("type")) ?: continue
                val id = value.optLong("id", -1)
                val localDate = value.optString("local_date")
                val createdAt = value.optLong("created_at_epoch_ms", -1)
                if (id > 0 && DATE_PATTERN.matches(localDate) && createdAt > 0) {
                    add(WearReminder(id, type, localDate, createdAt))
                }
            }
        }
    }

    /** Reads the last delivered reminder fingerprint for duplicate suppression. */
    fun lastNotifiedFingerprint(): String? = preferences.getString(LAST_NOTIFIED, null)

    /** Synchronously records successful reminder delivery and fails when persistence fails. */
    fun markNotified(fingerprint: String) {
        check(preferences.edit().putString(LAST_NOTIFIED, fingerprint).commit()) {
            "Unable to persist Wear reminder delivery state."
        }
    }

    /** Removes retained reminder delivery identity so future valid reminders can be evaluated afresh. */
    fun clearDeliveryState() {
        check(preferences.edit().remove(LAST_NOTIFIED).commit()) {
            "Unable to clear Wear reminder delivery state."
        }
    }

    private companion object {
        const val PREFERENCES = "calibrate_wear_reminders"
        const val REMINDERS = "active_reminders"
        const val LAST_NOTIFIED = "last_notified_fingerprint"
        val DATE_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    }
}

/** Posts one combined, watch-local reminder only when phone reachability is known to be absent. */
class WearReminderNotifier(private val context: Context) {
    private val appContext = context.applicationContext
    private val state = WearReminderStateStore(appContext)
    private val notificationManager = appContext.getSystemService(NotificationManager::class.java)

    /** Evaluates cached reminders against permission and trusted-phone reachability, suppressing delivery on uncertainty. */
    fun evaluate() {
        val permissionGranted = Build.VERSION.SDK_INT < 33 ||
            appContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        // Fail closed on Data Layer uncertainty so a transient Play Services error cannot create duplicates.
        val phoneReachable = runCatching {
            val session = AndroidKeystoreTokenStore(appContext).read()
                ?: throw IllegalStateException("Wear session is unavailable.")
            val binding = TrustedPhoneBindingStore(appContext).read(session)
                ?: throw IllegalStateException("Trusted phone binding is unavailable.")
            Tasks.await(
                Wearable.getNodeClient(appContext).connectedNodes,
                PHONE_REACHABILITY_TIMEOUT_SECONDS,
                TimeUnit.SECONDS
            ).any { it.id == binding.nodeId }
        }.getOrDefault(true)
        when (val decision = WearReminderPolicy.decide(
            state.read(), phoneReachable, permissionGranted, state.lastNotifiedFingerprint()
        )) {
            WearReminderDecision.Cancel -> {
                notificationManager.cancel(NOTIFICATION_ID)
                state.clearDeliveryState()
            }
            WearReminderDecision.None -> Unit
            is WearReminderDecision.Notify -> post(decision.notification)
        }
    }

    /** Cancels the local reminder and clears cached reminder and delivery state. */
    fun clear() {
        notificationManager.cancel(NOTIFICATION_ID)
        state.replace(emptyList())
        state.clearDeliveryState()
    }

    private fun post(reminder: WearReminderNotification) {
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Calibrate reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Food and weight reminders from your self-hosted Calibrate server"
            }
        )
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_DESTINATION, reminder.destination)
            putExtra(EXTRA_LOCAL_DATE, reminder.localDate)
        }
        val contentIntent = PendingIntent.getActivity(
            appContext,
            reminder.fingerprint.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val hasFood = WearReminderType.FOOD in reminder.types
        val hasWeight = WearReminderType.WEIGHT in reminder.types
        val body = when {
            hasFood && hasWeight -> "Log today's food and weight."
            hasWeight -> "Log today's weight."
            else -> "Log today's food."
        }
        val notification = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("calibrate")
            .setContentText(body)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setLocalOnly(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .build()
        notificationManager.notify(NOTIFICATION_ID, notification)
        state.markNotified(reminder.fingerprint)
    }

    companion object {
        const val EXTRA_DESTINATION = "calibrate_wear_reminder_destination"
        const val EXTRA_LOCAL_DATE = "calibrate_wear_reminder_local_date"
        private const val CHANNEL_ID = "calibrate-reminders-v1"
        private const val NOTIFICATION_ID = 4101
        private const val PHONE_REACHABILITY_TIMEOUT_SECONDS = 3L
    }
}

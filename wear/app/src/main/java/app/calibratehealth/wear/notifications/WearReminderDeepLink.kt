/** Allowlisted notification destinations for food summary and weight entry. */

package app.calibratehealth.wear.notifications

import android.content.Intent

data class WearReminderDeepLink(val destination: String, val localDate: String)

/** Strictly parse only notification intents emitted by this app's local notifier. */
fun parseWearReminderDeepLink(intent: Intent?): WearReminderDeepLink? {
    val destination = intent?.getStringExtra(WearReminderNotifier.EXTRA_DESTINATION) ?: return null
    if (destination != WearReminderNotification.DESTINATION_FOOD &&
        destination != WearReminderNotification.DESTINATION_WEIGHT
    ) return null
    val localDate = intent.getStringExtra(WearReminderNotifier.EXTRA_LOCAL_DATE) ?: return null
    if (!Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(localDate)) return null
    return WearReminderDeepLink(destination, localDate)
}

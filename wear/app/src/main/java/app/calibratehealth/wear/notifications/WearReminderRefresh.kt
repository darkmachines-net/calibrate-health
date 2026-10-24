/** Network- and battery-constrained periodic refresh for standalone watch reminders. */

package app.calibratehealth.wear.notifications

import android.content.Context
import androidx.work.Constraints
import androidx.work.Worker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.calibratehealth.wear.sync.WorkManagerOutboxScheduler
import java.util.concurrent.TimeUnit

/**
 * Hourly, battery-aware refresh gives a disconnected LTE/Wi-Fi watch a bounded reminder path.
 * Server reminder preferences and local-day scheduling remain authoritative.
 */
class WearReminderRefreshScheduler(context: Context) {
    private val workManager = WorkManager.getInstance(context.applicationContext)

    /** Schedules unique periodic reminder refresh with network and battery constraints. */
    fun schedule() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()
        val request = PeriodicWorkRequestBuilder<WearReminderRefreshWorker>(
            REFRESH_INTERVAL_HOURS,
            TimeUnit.HOURS,
            REFRESH_FLEX_MINUTES,
            TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .addTag(WORK_TAG)
            .build()
        workManager.enqueueUniquePeriodicWork(
            UNIQUE_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    companion object {
        const val UNIQUE_WORK_NAME = "calibrate-wear-reminders-v1"
        const val WORK_TAG = "calibrate-wear-reminders"
        private const val REFRESH_INTERVAL_HOURS = 1L
        private const val REFRESH_FLEX_MINUTES = 15L
    }
}

class WearReminderRefreshWorker(
    appContext: Context,
    workerParameters: WorkerParameters
) : Worker(appContext, workerParameters) {
    override fun doWork(): Result {
        // Reuse the unique FIFO chain so periodic and invalidation refreshes cannot race cache commits.
        WorkManagerOutboxScheduler(applicationContext).schedule()
        return Result.success()
    }
}

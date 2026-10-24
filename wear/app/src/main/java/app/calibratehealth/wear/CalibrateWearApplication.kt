/** Watch application startup and process-wide initialization. */

package app.calibratehealth.wear

import android.app.Application
import app.calibratehealth.wear.sync.WorkManagerOutboxScheduler
import app.calibratehealth.wear.sync.SyncInvalidationInbox
import app.calibratehealth.wear.notifications.WearReminderRefreshScheduler
import app.calibratehealth.wear.pairing.PairingStateStore
import app.calibratehealth.wear.pairing.PairingUiState

class CalibrateWearApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Recover persisted mutations if the process died between the Room commit and WorkManager enqueue.
        // The outbox worker refreshes the snapshot before releasing optimistic action locks.
        if (!SyncInvalidationInbox.recover(this)) {
            WorkManagerOutboxScheduler(this).scheduleForegroundRefresh()
        }
        if (PairingStateStore(this).currentUiState() is PairingUiState.Paired) {
            WearReminderRefreshScheduler(this).schedule()
        }
    }
}

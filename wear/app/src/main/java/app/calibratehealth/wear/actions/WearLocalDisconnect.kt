/** Ordered watch credential, account-cache, scheduled-work, and pairing cleanup. */

package app.calibratehealth.wear.actions

import android.content.Context
import androidx.work.WorkManager
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.security.AccountSessionCoordinator
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.RoomAccountDataStore
import app.calibratehealth.wear.pairing.PairingStateStore
import app.calibratehealth.wear.pairing.TrustedPhoneBindingStore
import app.calibratehealth.wear.sync.OutboxWorkPolicy
import app.calibratehealth.wear.sync.SyncInvalidationInbox
import app.calibratehealth.wear.tile.CalibrateTileUpdate
import app.calibratehealth.wear.notifications.WearReminderNotifier
import app.calibratehealth.wear.notifications.WearReminderRefreshScheduler

/** Clears this watch only. It intentionally never calls the server session-revocation API. */
class WearLocalDisconnect(context: Context) {
    private val appContext = context.applicationContext
    private val database = CalibrateWearDatabase.get(appContext)
    private val coordinator = AccountSessionCoordinator(
        AndroidKeystoreTokenStore(appContext),
        RoomAccountDataStore(database)
    )

    /** Removes credentials before account data, then cancels owned work, notifications, and pairing coordination state. */
    suspend fun disconnect(): Result<Unit> {
        val clearResult = runCatching { coordinator.clear() }
        // Credential removal happens before Room clearing, so cancellation cannot revive old access.
        runCatching {
            WorkManager.getInstance(appContext).cancelUniqueWork(WearReminderRefreshScheduler.UNIQUE_WORK_NAME)
            WorkManager.getInstance(appContext).cancelUniqueWork(OutboxWorkPolicy.UNIQUE_WORK_NAME)
        }
        runCatching { WearReminderNotifier(appContext).clear() }
        runCatching { SyncInvalidationInbox.clear(appContext) }
        runCatching { TrustedPhoneBindingStore(appContext).clear() }
        val pairingResult = runCatching { PairingStateStore(appContext).clearLocalPairingState() }
        CalibrateTileUpdate.request(appContext)
        return clearResult.fold(
            onSuccess = { pairingResult },
            onFailure = { Result.failure(it) }
        )
    }
}

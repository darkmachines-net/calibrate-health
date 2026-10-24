/** Reads a consistent account-scoped Tile snapshot from Room under the account transition lock. */

package app.calibratehealth.wear.tile

import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.security.AccountStateCriticalSection
import app.calibratehealth.wear.data.security.SecureTokenStore
import kotlinx.coroutines.flow.first

/** Reads only the local Room cache. Tile rendering must never initiate network work. */
class CalibrateTileCacheReader(
    private val database: CalibrateWearDatabase,
    private val tokenStore: SecureTokenStore,
    private val accountState: AccountStateCriticalSection = AccountStateCriticalSection.Shared
) {
    /** Reads an account-consistent cached Tile snapshot under the shared critical section without network access. */
    suspend fun latest(): CalibrateTileSnapshot? = accountState.withLock {
        // Keep snapshot and sync metadata from straddling an account replacement/clear.
        val session = runCatching { tokenStore.read() }.getOrNull() ?: return@withLock null
        val snapshot = database.dailySnapshotDao().observeLatest().first() ?: return@withLock null
        val metadata = database.syncMetadataDao().observe().first() ?: return@withLock null
        val pendingMutationTypes = database.queuedMutationDao().activeInFifoOrder().map { it.mutationType }.toSet()
        if (metadata.serverOrigin != session.serverOrigin) return@withLock null
        suppressTilePlanForPendingWeight(CalibrateTileSnapshot(
            caloriesConsumed = snapshot.caloriesConsumed,
            calorieTarget = snapshot.calorieTarget,
            caloriesRemaining = snapshot.caloriesRemaining,
            cachedAtEpochMs = metadata.lastSuccessAtEpochMs ?: snapshot.fetchedAtEpochMs,
            foodDayStatus = snapshot.foodDayStatus,
            planStatus = snapshot.planStatus
        ), pendingMutationTypes)
    }
}

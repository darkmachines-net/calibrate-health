/** Cache and outbox interfaces with Room adapters that preserve retention bounds and stable operation ordering. */

package app.calibratehealth.wear.data

import app.calibratehealth.wear.data.local.DailySnapshotDao
import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.MutationState
import app.calibratehealth.wear.data.local.QueuedMutationDao
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.QuickAddItemDao
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.data.local.SyncMetadataDao
import app.calibratehealth.wear.data.local.SyncMetadataEntity
import app.calibratehealth.wear.data.local.WearCacheLimits
import app.calibratehealth.wear.sync.OutboxScheduler
import kotlinx.coroutines.flow.Flow

interface DailySnapshotRepository {
    /** Observes the newest cached daily summary without performing network work. */
    fun observeLatest(): Flow<DailySnapshotEntity?>
    /** Reads cached daily summaries newest first. */
    suspend fun allNewestFirst(): List<DailySnapshotEntity>
    /** Stores a daily summary within the repository retention bound. */
    suspend fun cache(snapshot: DailySnapshotEntity)
}

interface QuickAddRepository {
    /** Observes the ranked quick-add snapshot without performing network work. */
    fun observeAll(): Flow<List<QuickAddItemEntity>>
    /** Reads the current ranked quick-add snapshot. */
    suspend fun all(): List<QuickAddItemEntity>
    /** Replaces quick-add entries within the repository retention bound. */
    suspend fun cache(items: List<QuickAddItemEntity>)
}

interface MutationOutboxRepository {
    /** Persists an operation once and schedules synchronization when insertion succeeds. */
    suspend fun enqueue(mutation: QueuedMutationEntity): Boolean
    /** Returns the oldest pending mutation available for replay. */
    suspend fun head(): QueuedMutationEntity?
    /** Lists pending operations in durable FIFO order. */
    suspend fun pendingInFifoOrder(): List<QueuedMutationEntity>
    /** Lists queued and awaiting-snapshot operations in durable FIFO order. */
    suspend fun activeInFifoOrder(): List<QueuedMutationEntity>
    /** Returns the newest terminal operation for user-facing synchronization status. */
    suspend fun latestTerminal(): QueuedMutationEntity?
    /** Records a retry for a still-pending operation and reports whether it was updated. */
    suspend fun recordRetry(operationId: String, error: String): Boolean
    /** Marks a pending operation accepted by the server while awaiting snapshot confirmation. */
    suspend fun recordServerSuccess(operationId: String): Boolean
    /** Finalizes accepted operations after refreshed data is committed and prunes terminal history. */
    suspend fun confirmSnapshotRefresh()
    /** Records a terminal failure for a still-pending operation and reports whether it was updated. */
    suspend fun recordFailure(operationId: String, error: String): Boolean
}

interface SyncMetadataRepository {
    /** Observes the current account synchronization metadata. */
    fun observe(): Flow<SyncMetadataEntity?>
    /** Reads the current synchronization metadata or null when absent. */
    suspend fun get(): SyncMetadataEntity?
    /** Persists the current account synchronization metadata. */
    suspend fun store(metadata: SyncMetadataEntity)
    /** Removes account synchronization metadata. */
    suspend fun clear()
}

class RoomDailySnapshotRepository(
    private val dao: DailySnapshotDao,
    private val maxRows: Int = WearCacheLimits.DAILY_SNAPSHOTS
) : DailySnapshotRepository {
    override fun observeLatest(): Flow<DailySnapshotEntity?> = dao.observeLatest()
    override suspend fun allNewestFirst(): List<DailySnapshotEntity> = dao.allNewestFirst()
    override suspend fun cache(snapshot: DailySnapshotEntity) = dao.cacheBounded(snapshot, maxRows)
}

class RoomQuickAddRepository(
    private val dao: QuickAddItemDao,
    private val maxRows: Int = WearCacheLimits.QUICK_ADD_ITEMS
) : QuickAddRepository {
    override fun observeAll(): Flow<List<QuickAddItemEntity>> = dao.observeAll()
    override suspend fun all(): List<QuickAddItemEntity> = dao.all()
    override suspend fun cache(items: List<QuickAddItemEntity>) = dao.cacheBounded(items, maxRows)
}

class RoomMutationOutboxRepository(
    private val dao: QueuedMutationDao,
    private val scheduler: OutboxScheduler,
    private val terminalMutationLimit: Int = WearCacheLimits.TERMINAL_MUTATIONS
) : MutationOutboxRepository {
    init {
        require(terminalMutationLimit > 0) { "Terminal mutation bound must be positive." }
    }

    override suspend fun enqueue(mutation: QueuedMutationEntity): Boolean {
        require(mutation.state == MutationState.PENDING) { "New mutations must be pending." }
        require(mutation.sequenceId == 0L) { "New mutations must let Room assign FIFO sequence." }
        val inserted = dao.insert(mutation) != -1L
        if (inserted) scheduler.schedule()
        return inserted
    }

    override suspend fun head(): QueuedMutationEntity? = dao.head()
    override suspend fun pendingInFifoOrder(): List<QueuedMutationEntity> = dao.pendingInFifoOrder()
    override suspend fun activeInFifoOrder(): List<QueuedMutationEntity> = dao.activeInFifoOrder()
    override suspend fun latestTerminal(): QueuedMutationEntity? = dao.latestTerminal()

    override suspend fun recordRetry(
        operationId: String,
        error: String
    ): Boolean = dao.markRetry(operationId, error) == 1

    override suspend fun recordServerSuccess(operationId: String): Boolean =
        dao.markServerSucceeded(operationId) == 1

    override suspend fun confirmSnapshotRefresh() {
        if (dao.confirmSnapshotRefresh() > 0) dao.pruneTerminal(terminalMutationLimit)
    }

    override suspend fun recordFailure(operationId: String, error: String): Boolean {
        val updated = dao.markFailed(operationId, error) == 1
        if (updated) dao.pruneTerminal(terminalMutationLimit)
        return updated
    }
}

class RoomSyncMetadataRepository(private val dao: SyncMetadataDao) : SyncMetadataRepository {
    override fun observe(): Flow<SyncMetadataEntity?> = dao.observe()
    override suspend fun get(): SyncMetadataEntity? = dao.get()
    override suspend fun store(metadata: SyncMetadataEntity) = dao.upsert(metadata)
    override suspend fun clear() = dao.clear()
}

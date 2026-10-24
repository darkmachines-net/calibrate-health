/** Regression tests and fixtures for Fake Wear Repositories. */

package app.calibratehealth.wear.data

import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.MutationState
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.data.local.SyncMetadataEntity
import app.calibratehealth.wear.data.local.WearCacheLimits
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenStore
import app.calibratehealth.wear.data.security.requireValid
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow

class FakeWearStorage {
    val snapshots = linkedMapOf<String, DailySnapshotEntity>()
    val quickAdds = linkedMapOf<String, QuickAddItemEntity>()
    val mutations = linkedMapOf<String, QueuedMutationEntity>()
    var nextMutationSequenceId = 1L
    var syncMetadata: SyncMetadataEntity? = null
    var secureSession: SecureSession? = null
}

class FakeDailySnapshotRepository(
    private val storage: FakeWearStorage,
    private val maxRows: Int
) : DailySnapshotRepository {
    private val latest = MutableStateFlow(newest().firstOrNull())

    override fun observeLatest(): Flow<DailySnapshotEntity?> = latest
    override suspend fun allNewestFirst(): List<DailySnapshotEntity> = newest()

    override suspend fun cache(snapshot: DailySnapshotEntity) {
        storage.snapshots[snapshot.localDate] = snapshot
        newest().drop(maxRows).forEach { storage.snapshots.remove(it.localDate) }
        latest.value = newest().firstOrNull()
    }

    private fun newest(): List<DailySnapshotEntity> =
        storage.snapshots.values.sortedByDescending(DailySnapshotEntity::localDate)
}

class FakeQuickAddRepository(
    private val storage: FakeWearStorage,
    private val maxRows: Int
) : QuickAddRepository {
    private val items = MutableStateFlow(ordered())

    override fun observeAll(): Flow<List<QuickAddItemEntity>> = items
    override suspend fun all(): List<QuickAddItemEntity> = ordered()

    override suspend fun cache(items: List<QuickAddItemEntity>) {
        storage.quickAdds.clear()
        items.forEach { storage.quickAdds[it.quickAddId] = it }
        ordered().drop(maxRows).forEach { storage.quickAdds.remove(it.quickAddId) }
        this.items.value = ordered()
    }

    private fun ordered(): List<QuickAddItemEntity> = storage.quickAdds.values.sortedWith(
        compareBy<QuickAddItemEntity> { it.sortRank }
            .thenByDescending { it.updatedAtEpochMs }
            .thenBy { it.quickAddId }
    )
}

class FakeMutationOutboxRepository(
    private val storage: FakeWearStorage,
    private val terminalMutationLimit: Int = WearCacheLimits.TERMINAL_MUTATIONS
) : MutationOutboxRepository {
    init {
        require(terminalMutationLimit > 0) { "Terminal mutation bound must be positive." }
    }

    override suspend fun enqueue(mutation: QueuedMutationEntity): Boolean {
        require(mutation.state == MutationState.PENDING) { "New mutations must be pending." }
        require(mutation.sequenceId == 0L) { "New mutations must let storage assign FIFO sequence." }
        if (storage.mutations.containsKey(mutation.operationId)) return false
        storage.mutations[mutation.operationId] = mutation.copy(
            sequenceId = storage.nextMutationSequenceId++
        )
        return true
    }

    override suspend fun head(): QueuedMutationEntity? = pendingInFifoOrder().firstOrNull()

    override suspend fun pendingInFifoOrder(): List<QueuedMutationEntity> =
        storage.mutations.values
            .filter { it.state == MutationState.PENDING }
            .sortedBy(QueuedMutationEntity::sequenceId)

    override suspend fun activeInFifoOrder(): List<QueuedMutationEntity> =
        storage.mutations.values
            .filter { it.state == MutationState.PENDING || it.state == MutationState.AWAITING_SNAPSHOT }
            .sortedBy(QueuedMutationEntity::sequenceId)

    override suspend fun latestTerminal(): QueuedMutationEntity? =
        storage.mutations.values
            .filter { it.state == MutationState.SUCCEEDED || it.state == MutationState.FAILED }
            .maxByOrNull(QueuedMutationEntity::sequenceId)

    override suspend fun recordRetry(
        operationId: String,
        error: String
    ): Boolean = updatePending(operationId) {
        it.copy(
            attemptCount = it.attemptCount + 1,
            lastError = error
        )
    }

    override suspend fun recordServerSuccess(operationId: String): Boolean = updatePending(operationId) {
        it.copy(state = MutationState.AWAITING_SNAPSHOT, lastError = null)
    }

    override suspend fun confirmSnapshotRefresh() {
        storage.mutations.replaceAll { _, mutation ->
            if (mutation.state == MutationState.AWAITING_SNAPSHOT) {
                mutation.copy(state = MutationState.SUCCEEDED, lastError = null)
            } else {
                mutation
            }
        }
        pruneTerminal()
    }

    override suspend fun recordFailure(operationId: String, error: String): Boolean {
        val updated = updatePending(operationId) {
            it.copy(state = MutationState.FAILED, lastError = error)
        }
        if (updated) pruneTerminal()
        return updated
    }

    private fun updatePending(
        operationId: String,
        transform: (QueuedMutationEntity) -> QueuedMutationEntity
    ): Boolean {
        val current = storage.mutations[operationId]?.takeIf { it.state == MutationState.PENDING } ?: return false
        storage.mutations[operationId] = transform(current)
        return true
    }

    private fun pruneTerminal() {
        storage.mutations.values
            .filter { it.state == MutationState.SUCCEEDED || it.state == MutationState.FAILED }
            .sortedByDescending(QueuedMutationEntity::sequenceId)
            .drop(terminalMutationLimit)
            .forEach { storage.mutations.remove(it.operationId) }
    }
}

class FakeSyncMetadataRepository(private val storage: FakeWearStorage) : SyncMetadataRepository {
    private val metadata = MutableStateFlow(storage.syncMetadata)

    override fun observe(): Flow<SyncMetadataEntity?> = metadata
    override suspend fun get(): SyncMetadataEntity? = storage.syncMetadata

    override suspend fun store(metadata: SyncMetadataEntity) {
        storage.syncMetadata = metadata
        this.metadata.value = metadata
    }

    override suspend fun clear() {
        storage.syncMetadata = null
        metadata.value = null
    }
}

class FakeSecureTokenStore(private val storage: FakeWearStorage) : SecureTokenStore {
    override fun read(): SecureSession? = storage.secureSession
    override fun write(session: SecureSession) {
        session.requireValid()
        storage.secureSession = session
    }
    override fun clear() {
        storage.secureSession = null
    }
}

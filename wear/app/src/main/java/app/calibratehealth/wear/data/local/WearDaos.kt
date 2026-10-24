/** Transactional Room access for bounded snapshots, ranked quick-add items, FIFO mutations, and sync metadata. */

package app.calibratehealth.wear.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
abstract class DailySnapshotDao {
    /** Observes the newest cached daily snapshot as local persistence changes. */
    @Query("SELECT * FROM daily_snapshots ORDER BY local_date DESC LIMIT 1")
    abstract fun observeLatest(): Flow<DailySnapshotEntity?>

    /** Reads all cached daily snapshots in descending local-date order. */
    @Query("SELECT * FROM daily_snapshots ORDER BY local_date DESC")
    abstract suspend fun allNewestFirst(): List<DailySnapshotEntity>

    @Upsert
    protected abstract suspend fun upsert(snapshot: DailySnapshotEntity)

    @Query(
        """
        DELETE FROM daily_snapshots
        WHERE local_date NOT IN (
            SELECT local_date FROM daily_snapshots ORDER BY local_date DESC LIMIT :maxRows
        )
        """
    )
    protected abstract suspend fun prune(maxRows: Int)

    /** Deletes all cached daily snapshots during account cleanup. */
    @Query("DELETE FROM daily_snapshots")
    abstract suspend fun clearAll()

    /** Upserts a daily snapshot and prunes older rows atomically to the positive retention bound. */
    @Transaction
    open suspend fun cacheBounded(snapshot: DailySnapshotEntity, maxRows: Int) {
        require(maxRows > 0) { "Snapshot cache bound must be positive." }
        upsert(snapshot)
        prune(maxRows)
    }
}

@Dao
abstract class QuickAddItemDao {
    /** Observes quick-add items in ranked display order. */
    @Query("SELECT * FROM quick_add_items ORDER BY sort_rank ASC, updated_at_epoch_ms DESC, quick_add_id ASC")
    abstract fun observeAll(): Flow<List<QuickAddItemEntity>>

    /** Reads the current ranked quick-add snapshot. */
    @Query("SELECT * FROM quick_add_items ORDER BY sort_rank ASC, updated_at_epoch_ms DESC, quick_add_id ASC")
    abstract suspend fun all(): List<QuickAddItemEntity>

    @Upsert
    protected abstract suspend fun upsertAll(items: List<QuickAddItemEntity>)

    /** Deletes the entire quick-add snapshot. */
    @Query("DELETE FROM quick_add_items")
    abstract suspend fun clearAll()

    @Query(
        """
        DELETE FROM quick_add_items
        WHERE quick_add_id NOT IN (
            SELECT quick_add_id FROM quick_add_items
            ORDER BY sort_rank ASC, updated_at_epoch_ms DESC, quick_add_id ASC
            LIMIT :maxRows
        )
        """
    )
    protected abstract suspend fun prune(maxRows: Int)

    /** Atomically replaces quick-add items and prunes them to the positive retention bound. */
    @Transaction
    open suspend fun cacheBounded(items: List<QuickAddItemEntity>, maxRows: Int) {
        require(maxRows > 0) { "Quick-add cache bound must be positive." }
        clearAll()
        upsertAll(items)
        prune(maxRows)
    }
}

@Dao
interface QueuedMutationDao {
    /** Inserts a mutation once by its unique operation identity, ignoring duplicate inserts. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(mutation: QueuedMutationEntity): Long

    /** Returns the oldest pending mutation by durable sequence. */
    @Query(
        """
        SELECT * FROM queued_mutations
        WHERE state = 'pending'
        ORDER BY sequence_id ASC
        LIMIT 1
        """
    )
    suspend fun head(): QueuedMutationEntity?

    /** Lists pending mutations in FIFO sequence order. */
    @Query(
        """
        SELECT * FROM queued_mutations
        WHERE state = 'pending'
        ORDER BY sequence_id ASC
        """
    )
    suspend fun pendingInFifoOrder(): List<QueuedMutationEntity>

    /** Lists pending and awaiting-snapshot mutations in FIFO sequence order. */
    @Query(
        """
        SELECT * FROM queued_mutations
        WHERE state IN ('pending', 'awaiting_snapshot')
        ORDER BY sequence_id ASC
        """
    )
    suspend fun activeInFifoOrder(): List<QueuedMutationEntity>

    /** Returns the most recent succeeded or failed operation record. */
    @Query(
        """
        SELECT * FROM queued_mutations
        WHERE state IN ('succeeded', 'failed')
        ORDER BY sequence_id DESC
        LIMIT 1
        """
    )
    suspend fun latestTerminal(): QueuedMutationEntity?

    /** Increments attempts and stores the error only while the operation remains pending. */
    @Query(
        """
        UPDATE queued_mutations
        SET attempt_count = attempt_count + 1,
            last_error = :error
        WHERE operation_id = :operationId AND state = 'pending'
        """
    )
    suspend fun markRetry(operationId: String, error: String): Int

    /** Moves a pending operation to awaiting-snapshot after server success. */
    @Query(
        """
        UPDATE queued_mutations
        SET state = 'awaiting_snapshot', last_error = NULL
        WHERE operation_id = :operationId AND state = 'pending'
        """
    )
    suspend fun markServerSucceeded(operationId: String): Int

    /** Finalizes awaiting-snapshot operations after the refreshed snapshot is committed. */
    @Query(
        """
        UPDATE queued_mutations
        SET state = 'succeeded', last_error = NULL
        WHERE state = 'awaiting_snapshot'
        """
    )
    suspend fun confirmSnapshotRefresh(): Int

    /** Marks a pending operation terminally failed with its recovery message. */
    @Query(
        """
        UPDATE queued_mutations
        SET state = 'failed', last_error = :error
        WHERE operation_id = :operationId AND state = 'pending'
        """
    )
    suspend fun markFailed(operationId: String, error: String): Int

    /** Retains only the newest bounded terminal operation records. */
    @Query(
        """
        DELETE FROM queued_mutations
        WHERE state IN ('succeeded', 'failed') AND operation_id NOT IN (
            SELECT operation_id FROM queued_mutations
            WHERE state IN ('succeeded', 'failed')
            ORDER BY sequence_id DESC
            LIMIT :maxRows
        )
        """
    )
    suspend fun pruneTerminal(maxRows: Int)

    /** Deletes all queued mutations and terminal records during account cleanup. */
    @Query("DELETE FROM queued_mutations")
    suspend fun clearAll()
}

@Dao
interface SyncMetadataDao {
    /** Observes the singleton synchronization metadata row. */
    @Query("SELECT * FROM sync_metadata WHERE id = 1")
    fun observe(): Flow<SyncMetadataEntity?>

    /** Reads the singleton synchronization metadata row or null when unpaired. */
    @Query("SELECT * FROM sync_metadata WHERE id = 1")
    suspend fun get(): SyncMetadataEntity?

    /** Replaces the singleton synchronization metadata with the supplied account scope. */
    @Upsert
    suspend fun upsert(metadata: SyncMetadataEntity)

    /** Removes synchronization metadata during account cleanup. */
    @Query("DELETE FROM sync_metadata")
    suspend fun clear()
}

/** Regression tests and fixtures for Watch Snapshot Synchronizer. */

package app.calibratehealth.wear.sync

import app.calibratehealth.wear.data.DailySnapshotRepository
import app.calibratehealth.wear.data.QuickAddRepository
import app.calibratehealth.wear.data.SyncMetadataRepository
import app.calibratehealth.wear.data.local.DailySnapshotEntity
import app.calibratehealth.wear.data.local.QuickAddItemEntity
import app.calibratehealth.wear.data.local.SyncMetadataEntity
import app.calibratehealth.wear.network.AuthenticatedApiResult
import app.calibratehealth.wear.network.WatchHttpResponse
import app.calibratehealth.wear.network.WatchSnapshotApi
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchSnapshotSynchronizerTest {
    /** Verifies that clears old etag before cache writes and stores replacement etag last. */
    @Test
    fun `clears old etag before cache writes and stores replacement etag last`() = runBlocking {
        val events = mutableListOf<String>()
        val existing = SyncMetadataEntity(
            serverOrigin = "https://health.example.com",
            syncCursor = "W/\"watch-old\"",
            lastSuccessAtEpochMs = 1,
            invalidatedAtEpochMs = null,
            protocolVersion = 1
        )
        val metadata = RecordingMetadataRepository(existing, events)
        val tokenStore = MemoryTokenStore(session())
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, etag ->
                assertEquals(existing.syncCursor, etag)
                AuthenticatedApiResult.Response(
                    WatchHttpResponse(200, mapOf("ETag" to "W/\"watch-new\""), validSnapshot())
                )
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = metadata,
            tokenStore = tokenStore,
            onRemindersChanged = { events += "reminders.store" },
            nowEpochMs = { 42 }
        )

        assertTrue(synchronizer.refresh { events += "outbox.unlock" } is SnapshotSyncResult.Success)
        assertEquals(
            listOf("metadata.clear", "snapshot.cache", "quick_add.cache", "reminders.store", "metadata.store", "outbox.unlock"),
            events
        )
        assertEquals("W/\"watch-new\"", metadata.value?.syncCursor)
    }

    /** Verifies that account switch during fetch cannot commit snapshot rows. */
    @Test
    fun `account switch during fetch cannot commit snapshot rows`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = MemoryTokenStore(session())
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, _ ->
                tokenStore.value = session().copy(userId = 99)
                AuthenticatedApiResult.Response(
                    WatchHttpResponse(200, mapOf("ETag" to "W/\"watch-new\""), validSnapshot())
                )
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = RecordingMetadataRepository(
                SyncMetadataEntity(serverOrigin = "https://health.example.com", syncCursor = null, lastSuccessAtEpochMs = null, invalidatedAtEpochMs = null, protocolVersion = 1),
                events
            ),
            tokenStore = tokenStore,
            nowEpochMs = { 42 }
        )

        assertEquals(SnapshotSyncResult.AccountChanged, synchronizer.refresh { events += "outbox.unlock" })
        assertTrue(events.isEmpty())
    }

    /** Verifies that upgrade requirement blocks cache replacement and reaches the compatibility ui callback. */
    @Test
    fun `upgrade requirement blocks cache replacement and reaches the compatibility UI callback`() = runBlocking {
        val events = mutableListOf<String>()
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, _ ->
                AuthenticatedApiResult.UpgradeRequired("Update this watch.", "0.2.0")
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = RecordingMetadataRepository(
                SyncMetadataEntity(
                    serverOrigin = "https://health.example.com",
                    syncCursor = null,
                    lastSuccessAtEpochMs = null,
                    invalidatedAtEpochMs = null,
                    protocolVersion = 1
                ),
                events
            ),
            tokenStore = MemoryTokenStore(session()),
            onUpgradeRequired = { events += "upgrade:$it" },
            nowEpochMs = { 42 }
        )

        assertEquals(
            SnapshotSyncResult.PermanentFailure("Update this watch."),
            synchronizer.refresh()
        )
        assertEquals(listOf("upgrade:Update this watch."), events)
    }

    /** Verifies that upgrade response from a replaced account cannot transfer the compatibility marker. */
    @Test
    fun `upgrade response from a replaced account cannot transfer the compatibility marker`() = runBlocking {
        val events = mutableListOf<String>()
        val tokenStore = MemoryTokenStore(session())
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, _ ->
                tokenStore.value = session().copy(userId = 99)
                AuthenticatedApiResult.UpgradeRequired("Stale update requirement.", "0.2.0")
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = RecordingMetadataRepository(
                SyncMetadataEntity(
                    serverOrigin = "https://health.example.com",
                    syncCursor = null,
                    lastSuccessAtEpochMs = null,
                    invalidatedAtEpochMs = null,
                    protocolVersion = 1
                ),
                events
            ),
            tokenStore = tokenStore,
            onUpgradeRequired = { events += "upgrade:$it" },
            nowEpochMs = { 42 }
        )

        assertEquals(SnapshotSyncResult.AccountChanged, synchronizer.refresh())
        assertTrue(events.isEmpty())
    }

    /** Verifies that compatible retry after 426 restores ui and unlocks retained work. */
    @Test
    fun `compatible retry after 426 restores UI and unlocks retained work`() = runBlocking {
        val events = mutableListOf<String>()
        var compatible = false
        val tokenStore = MemoryTokenStore(session())
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, _ ->
                if (compatible) {
                    AuthenticatedApiResult.Response(
                        WatchHttpResponse(200, mapOf("ETag" to "W/\"watch-new\""), validSnapshot())
                    )
                } else {
                    AuthenticatedApiResult.UpgradeRequired("Update this watch.", "0.2.0")
                }
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = RecordingMetadataRepository(
                SyncMetadataEntity(
                    serverOrigin = "https://health.example.com",
                    syncCursor = null,
                    lastSuccessAtEpochMs = null,
                    invalidatedAtEpochMs = null,
                    protocolVersion = 1
                ),
                events
            ),
            tokenStore = tokenStore,
            onUpgradeRequired = { events += "upgrade:$it" },
            onCompatibilityRestored = { events += "compatibility.restored" },
            nowEpochMs = { 42 }
        )

        assertEquals(
            SnapshotSyncResult.PermanentFailure("Update this watch."),
            synchronizer.refresh { events += "outbox.unlock" }
        )
        assertEquals(listOf("upgrade:Update this watch."), events)
        assertEquals("access", tokenStore.value?.accessToken)

        compatible = true
        assertEquals(
            SnapshotSyncResult.Success,
            synchronizer.refresh { events += "outbox.unlock" }
        )
        assertEquals(
            listOf(
                "upgrade:Update this watch.",
                "metadata.clear",
                "snapshot.cache",
                "quick_add.cache",
                "metadata.store",
                "outbox.unlock",
                "compatibility.restored"
            ),
            events
        )
        assertEquals("access", tokenStore.value?.accessToken)
    }

    /** Verifies that not-modified retry after 426 preserves cache then clears compatibility state. */
    @Test
    fun `not-modified retry after 426 preserves cache then clears compatibility state`() = runBlocking {
        val events = mutableListOf<String>()
        var compatible = false
        val tokenStore = MemoryTokenStore(session())
        val existing = SyncMetadataEntity(
            serverOrigin = "https://health.example.com",
            syncCursor = "W/\"watch-current\"",
            lastSuccessAtEpochMs = 1,
            invalidatedAtEpochMs = null,
            protocolVersion = 1
        )
        val metadata = RecordingMetadataRepository(existing, events)
        val synchronizer = WatchSnapshotSynchronizer(
            api = WatchSnapshotApi { _, etag ->
                assertEquals(existing.syncCursor, etag)
                if (compatible) {
                    AuthenticatedApiResult.Response(WatchHttpResponse(304, emptyMap(), ""))
                } else {
                    AuthenticatedApiResult.UpgradeRequired("Update this watch.", "0.2.0")
                }
            },
            snapshots = RecordingSnapshotRepository(events),
            quickAdds = RecordingQuickAddRepository(events),
            metadata = metadata,
            tokenStore = tokenStore,
            onUpgradeRequired = { events += "upgrade:$it" },
            onCompatibilityRestored = { events += "compatibility.restored" },
            nowEpochMs = { 42 }
        )

        assertEquals(
            SnapshotSyncResult.PermanentFailure("Update this watch."),
            synchronizer.refresh { events += "outbox.unlock" }
        )
        compatible = true
        assertEquals(
            SnapshotSyncResult.NotModified,
            synchronizer.refresh { events += "outbox.unlock" }
        )
        assertEquals(
            listOf(
                "upgrade:Update this watch.",
                "metadata.store",
                "outbox.unlock",
                "compatibility.restored"
            ),
            events
        )
        assertEquals(42L, metadata.value?.lastSuccessAtEpochMs)
        assertEquals("access", tokenStore.value?.accessToken)
    }

    private class RecordingSnapshotRepository(private val events: MutableList<String>) : DailySnapshotRepository {
        override fun observeLatest(): Flow<DailySnapshotEntity?> = MutableStateFlow(null)
        override suspend fun allNewestFirst(): List<DailySnapshotEntity> = emptyList()
        override suspend fun cache(snapshot: DailySnapshotEntity) { events += "snapshot.cache" }
    }

    private class RecordingQuickAddRepository(private val events: MutableList<String>) : QuickAddRepository {
        override fun observeAll(): Flow<List<QuickAddItemEntity>> = MutableStateFlow(emptyList())
        override suspend fun all(): List<QuickAddItemEntity> = emptyList()
        override suspend fun cache(items: List<QuickAddItemEntity>) { events += "quick_add.cache" }
    }

    private class RecordingMetadataRepository(
        initial: SyncMetadataEntity,
        private val events: MutableList<String>
    ) : SyncMetadataRepository {
        var value: SyncMetadataEntity? = initial
        override fun observe(): Flow<SyncMetadataEntity?> = MutableStateFlow(value)
        override suspend fun get(): SyncMetadataEntity? = value
        override suspend fun store(metadata: SyncMetadataEntity) {
            events += "metadata.store"
            value = metadata
        }
        override suspend fun clear() {
            events += "metadata.clear"
            value = null
        }
    }

    private class MemoryTokenStore(var value: SecureSession?) : SecureTokenStore {
        override fun read(): SecureSession? = value
        override fun write(session: SecureSession) { value = session }
        override fun clear() { value = null }
    }

    private fun session() = SecureSession(
        accessToken = "access",
        refreshToken = "refresh",
        userId = 7,
        serverOrigin = "https://health.example.com",
        watchDeviceId = "watch-7",
        accessExpiresAtEpochMs = 100_000,
        refreshExpiresAtEpochMs = 200_000
    )

    private fun validSnapshot(): String = """
        {
          "server_time":"2026-07-11T01:00:00Z","timezone":"America/Los_Angeles","weight_unit":"KG",
          "revision":"0123456789abcdef01234567","local_date":"2026-07-11",
          "calories":{"consumed":750,"target":2000,"remaining":1250,"missing":[]},
          "food_day":{"is_complete":false,"completed_at":null,"revision":null},
          "weight":{"today_grams":null,"today_revision":null,"latest_grams":81500,"latest_revision":"abcdef0123456789abcdef01","latest_date":"2026-07-11"},
          "quick_add":[{"id":"my-food:4","source":"pinned","label":"Yogurt","calories":120,"draft":{"date":"2026-07-11","meal_period":"LUNCH","my_food_id":4,"servings_consumed":1}}],
          "reminders":[],
          "undo_candidate":null
        }
    """.trimIndent()
}

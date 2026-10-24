/** Conditional snapshot refresh, account-safe cache commits, and worker dependency reconstruction. */

package app.calibratehealth.wear.sync

import android.content.Context
import app.calibratehealth.wear.data.DailySnapshotRepository
import app.calibratehealth.wear.data.QuickAddRepository
import app.calibratehealth.wear.data.RoomDailySnapshotRepository
import app.calibratehealth.wear.data.RoomMutationOutboxRepository
import app.calibratehealth.wear.data.RoomQuickAddRepository
import app.calibratehealth.wear.data.RoomSyncMetadataRepository
import app.calibratehealth.wear.data.MutationOutboxRepository
import app.calibratehealth.wear.data.SyncMetadataRepository
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.local.QueuedMutationEntity
import app.calibratehealth.wear.data.local.SyncMetadataEntity
import app.calibratehealth.wear.data.security.AccountSessionCoordinator
import app.calibratehealth.wear.data.security.AccountStateCriticalSection
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.RoomAccountDataStore
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.data.security.SecureTokenStore
import app.calibratehealth.wear.data.security.accountScope
import app.calibratehealth.wear.network.AuthenticatedApiResult
import app.calibratehealth.wear.network.AuthenticatedWatchApi
import app.calibratehealth.wear.network.InvalidJsonException
import app.calibratehealth.wear.network.pairedPhoneFirstHttpTransport
import app.calibratehealth.wear.network.WatchSnapshotMapper
import app.calibratehealth.wear.network.requireObject
import app.calibratehealth.wear.network.WatchMutationApi
import app.calibratehealth.wear.network.WatchSnapshotApi
import app.calibratehealth.wear.notifications.WearReminderStateStore
import app.calibratehealth.wear.notifications.WearReminderRefreshScheduler
import app.calibratehealth.wear.pairing.PairingStateStore

enum class HttpOutcome {
    SUCCESS,
    NOT_MODIFIED,
    CONFLICT,
    RETRYABLE,
    PERMANENT
}

/** Shared status policy keeps snapshot and mutation workers consistent and JVM-testable. */
fun classifyWatchHttpStatus(status: Int): HttpOutcome = when {
    status in 200..299 -> HttpOutcome.SUCCESS
    status == 304 -> HttpOutcome.NOT_MODIFIED
    status == 409 -> HttpOutcome.CONFLICT
    status == 408 || status == 425 || status == 429 || status in 500..599 -> HttpOutcome.RETRYABLE
    else -> HttpOutcome.PERMANENT
}

class AuthenticatedMutationSender(
    private val api: WatchMutationApi,
    private val onAuthenticationRequired: (String) -> Unit = {}
) : MutationSender {
    override suspend fun send(mutation: QueuedMutationEntity, session: SecureSession): MutationSendResult {
        val result = try {
            api.postMutation(session, mutation.operationId, mutation.mutationType, mutation.payloadJson)
        } catch (error: InvalidJsonException) {
            return MutationSendResult.PermanentFailure(error.message ?: "Invalid queued mutation payload.")
        } catch (error: IllegalArgumentException) {
            return MutationSendResult.PermanentFailure(error.message ?: "Invalid queued mutation.")
        }
        return when (result) {
            is AuthenticatedApiResult.RetryableFailure -> MutationSendResult.Retryable(result.message)
            // Keep durable intent pending so a successful re-pair can resume the FIFO unchanged.
            is AuthenticatedApiResult.AuthenticationRequired -> {
                onAuthenticationRequired(result.message)
                MutationSendResult.Retryable(result.message)
            }
            is AuthenticatedApiResult.AccountChanged -> MutationSendResult.AccountChanged
            is AuthenticatedApiResult.InvalidResponse -> MutationSendResult.PermanentFailure(result.message)
            // The outbox processor applies the UI marker only after confirming this account is current.
            is AuthenticatedApiResult.UpgradeRequired -> MutationSendResult.UpgradeRequired(result.message)
            is AuthenticatedApiResult.Response -> when (classifyWatchHttpStatus(result.value.status)) {
                HttpOutcome.SUCCESS -> MutationSendResult.Success
                HttpOutcome.CONFLICT -> classifyConflict(result.value.body)
                HttpOutcome.RETRYABLE -> MutationSendResult.Retryable(
                    responseError(result.value.body, "Watch API returned HTTP ${result.value.status}.")
                )
                HttpOutcome.PERMANENT, HttpOutcome.NOT_MODIFIED -> MutationSendResult.PermanentFailure(
                    responseError(result.value.body, "Watch API returned HTTP ${result.value.status}.")
                )
            }
        }
    }
}

sealed interface SnapshotSyncResult {
    data object Success : SnapshotSyncResult
    data object NotModified : SnapshotSyncResult
    data class Retryable(val message: String) : SnapshotSyncResult
    data class PermanentFailure(val message: String) : SnapshotSyncResult
    data object AccountChanged : SnapshotSyncResult
}

class WatchSnapshotSynchronizer(
    private val api: WatchSnapshotApi,
    private val snapshots: DailySnapshotRepository,
    private val quickAdds: QuickAddRepository,
    private val metadata: SyncMetadataRepository,
    private val tokenStore: SecureTokenStore,
    private val accountState: AccountStateCriticalSection = AccountStateCriticalSection.Shared,
    private val onAuthenticationRequired: (String) -> Unit = {},
    private val onUpgradeRequired: (String) -> Unit = {},
    private val onCompatibilityRestored: () -> Unit = {},
    private val onRemindersChanged: (List<app.calibratehealth.wear.notifications.WearReminder>) -> Unit = {},
    private val nowEpochMs: () -> Long = System::currentTimeMillis
) {
    /** Refreshes conditional server state and commits it only while the captured account remains current. */
    suspend fun refresh(
        onAuthoritativeSnapshotCommitted: suspend () -> Unit = {}
    ): SnapshotSyncResult {
        val captured = accountState.withLock {
            val session = runCatching { tokenStore.read() }.getOrNull() ?: return@withLock null
            CapturedSnapshotWork(session, metadata.get())
        } ?: run {
            return SnapshotSyncResult.PermanentFailure("Pair the watch before refreshing health data.")
        }
        val response = when (val result = api.getSnapshot(captured.session, captured.metadata?.syncCursor)) {
            is AuthenticatedApiResult.Response -> result.value
            is AuthenticatedApiResult.RetryableFailure -> return SnapshotSyncResult.Retryable(result.message)
            is AuthenticatedApiResult.AuthenticationRequired -> {
                onAuthenticationRequired(result.message)
                return SnapshotSyncResult.PermanentFailure(result.message)
            }
            is AuthenticatedApiResult.AccountChanged -> return SnapshotSyncResult.AccountChanged
            is AuthenticatedApiResult.InvalidResponse -> return SnapshotSyncResult.PermanentFailure(result.message)
            is AuthenticatedApiResult.UpgradeRequired -> return accountState.withLock {
                if (!scopeStillCurrent(captured.session)) return@withLock SnapshotSyncResult.AccountChanged
                onUpgradeRequired(result.message)
                SnapshotSyncResult.PermanentFailure(result.message)
            }
        }
        val fetchedAt = nowEpochMs()
        return when (classifyWatchHttpStatus(response.status)) {
            HttpOutcome.NOT_MODIFIED -> try {
                if (captured.metadata == null) {
                    SnapshotSyncResult.Retryable("Watch API returned 304 without a cached snapshot cursor.")
                } else {
                    accountState.withLock {
                        if (!scopeStillCurrent(captured.session)) return@withLock SnapshotSyncResult.AccountChanged
                        metadata.store(captured.metadata.copy(lastSuccessAtEpochMs = fetchedAt))
                        onAuthoritativeSnapshotCommitted()
                        onCompatibilityRestored()
                        SnapshotSyncResult.NotModified
                    }
                }
            } catch (error: Exception) {
                SnapshotSyncResult.PermanentFailure(error.message ?: "Watch snapshot commit failed.")
            }
            HttpOutcome.SUCCESS -> try {
                val mapped = WatchSnapshotMapper.map(response.body, fetchedAt)
                val etag = response.header("ETag")?.trim()?.takeIf { it.length in 1..256 }
                    ?: return SnapshotSyncResult.PermanentFailure("Watch snapshot omitted a valid ETag.")
                // Invalidate the conditional cursor before either cache write. A crash can cause a full
                // refetch, but can never produce a 304 that blesses a partially replaced cache.
                accountState.withLock {
                    if (!scopeStillCurrent(captured.session)) return@withLock SnapshotSyncResult.AccountChanged
                    metadata.clear()
                    snapshots.cache(mapped.dailySnapshot)
                    quickAdds.cache(mapped.quickAddItems)
                    onRemindersChanged(mapped.reminders)
                    // Store the cursor last so a crash cannot advertise an ETag for data not fully cached.
                    metadata.store(
                        SyncMetadataEntity(
                            serverOrigin = captured.session.serverOrigin,
                            syncCursor = etag,
                            lastSuccessAtEpochMs = fetchedAt,
                            invalidatedAtEpochMs = null,
                            protocolVersion = WATCH_SYNC_PROTOCOL_VERSION
                        )
                    )
                    // Keep cache replacement and action unlock in the same account critical section.
                    onAuthoritativeSnapshotCommitted()
                    onCompatibilityRestored()
                    SnapshotSyncResult.Success
                }
            } catch (error: Exception) {
                SnapshotSyncResult.PermanentFailure(error.message ?: "Invalid Watch snapshot response.")
            }
            HttpOutcome.RETRYABLE -> SnapshotSyncResult.Retryable(
                responseError(response.body, "Watch API returned HTTP ${response.status}.")
            )
            HttpOutcome.CONFLICT, HttpOutcome.PERMANENT -> SnapshotSyncResult.PermanentFailure(
                responseError(response.body, "Watch API returned HTTP ${response.status}.")
            )
        }
    }

    private fun scopeStillCurrent(captured: SecureSession): Boolean =
        runCatching { tokenStore.read()?.accountScope() }.getOrNull() == captured.accountScope()

    companion object {
        const val WATCH_SYNC_PROTOCOL_VERSION = 1
    }
}

private data class CapturedSnapshotWork(
    val session: SecureSession,
    val metadata: SyncMetadataEntity?
)

/** Explicit event hook used after pairing; no periodic worker is registered. */
object WearSyncScheduler {
    /** Schedules outbox synchronization and periodic reminder refresh after successful pairing. */
    fun scheduleAfterPairing(context: Context) {
        WorkManagerOutboxScheduler(context).schedule()
        WearReminderRefreshScheduler(context).schedule()
    }
}

data class WearSyncDependencies(
    val outboxProcessor: OutboxProcessor,
    val snapshotSynchronizer: WatchSnapshotSynchronizer,
    val outboxRepository: MutationOutboxRepository
)

/** Process-independent dependency graph used whenever WorkManager recreates a worker. */
object WearSyncRuntime {
    /** Reconstructs database, secure session, HTTP, and synchronization dependencies for a fresh worker process. */
    fun create(context: Context): WearSyncDependencies {
        val appContext = context.applicationContext
        val database = CalibrateWearDatabase.get(appContext)
        val tokenStore = AndroidKeystoreTokenStore(appContext)
        val coordinator = AccountSessionCoordinator(tokenStore, RoomAccountDataStore(database))
        val api = AuthenticatedWatchApi(tokenStore, coordinator, pairedPhoneFirstHttpTransport(appContext))
        val noOpScheduler = object : OutboxScheduler {
            override fun schedule() = Unit
            override fun scheduleContinuation() = Unit
        }
        val outbox = RoomMutationOutboxRepository(database.queuedMutationDao(), noOpScheduler)
        val authenticationRequired: (String) -> Unit = { message ->
            PairingStateStore(appContext).setSessionInvalid(message)
        }
        val upgradeRequired: (String) -> Unit = { message ->
            PairingStateStore(appContext).setUpgradeRequired(message)
        }
        val compatibilityRestored: () -> Unit = {
            PairingStateStore(appContext).clearUpgradeRequired()
        }
        return WearSyncDependencies(
            outboxProcessor = FifoOutboxProcessor(
                repository = outbox,
                sender = AuthenticatedMutationSender(api, authenticationRequired),
                tokenStore = tokenStore,
                onAuthenticationRequired = authenticationRequired,
                onUpgradeRequired = upgradeRequired
            ),
            snapshotSynchronizer = WatchSnapshotSynchronizer(
                api = api,
                snapshots = RoomDailySnapshotRepository(database.dailySnapshotDao()),
                quickAdds = RoomQuickAddRepository(database.quickAddItemDao()),
                metadata = RoomSyncMetadataRepository(database.syncMetadataDao()),
                tokenStore = tokenStore,
                onAuthenticationRequired = authenticationRequired,
                onUpgradeRequired = upgradeRequired,
                onCompatibilityRestored = compatibilityRestored,
                onRemindersChanged = WearReminderStateStore(appContext)::replace
            ),
            outboxRepository = outbox
        )
    }
}

internal fun classifyConflict(body: String): MutationSendResult {
    val error = parseResponseError(body)
    return if (error.code == "OPERATION_IN_PROGRESS" && error.retryable == true) {
        MutationSendResult.Retryable(error.message ?: "Operation is still in progress.")
    } else {
        MutationSendResult.Conflict(error.message ?: "Mutation conflicted.")
    }
}

private data class ApiError(val message: String?, val code: String?, val retryable: Boolean?)

private fun parseResponseError(body: String): ApiError {
    if (body.isBlank() || body.length > 8 * 1024) return ApiError(null, null, null)
    return try {
        val root = app.calibratehealth.wear.network.StrictJson.parse(body).requireObject()
        ApiError(
            message = (root.values["message"] as? app.calibratehealth.wear.network.JsonValue.StringValue)
                ?.value?.takeIf { it.isNotBlank() && it.length <= 500 },
            code = (root.values["code"] as? app.calibratehealth.wear.network.JsonValue.StringValue)
                ?.value?.takeIf { it.length <= 100 },
            retryable = (root.values["retryable"] as? app.calibratehealth.wear.network.JsonValue.BooleanValue)?.value
        )
    } catch (_: Exception) {
        ApiError(null, null, null)
    }
}

private fun responseError(body: String, fallback: String): String {
    return parseResponseError(body).message ?: fallback
}

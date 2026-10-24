/** Receives bounded pairing, invalidation, and disconnect messages from authorized Data Layer peers. */

package app.calibratehealth.wear.pairing

import android.content.Context
import app.calibratehealth.wear.BuildConfig
import app.calibratehealth.wear.actions.WearLocalDisconnect
import app.calibratehealth.wear.data.local.CalibrateWearDatabase
import app.calibratehealth.wear.data.security.AccountSessionCoordinator
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.RoomAccountDataStore
import app.calibratehealth.wear.notifications.WearReminderNotifier
import app.calibratehealth.wear.network.pairingPhoneFirstHttpTransport
import app.calibratehealth.wear.sync.SyncInvalidationInbox
import app.calibratehealth.wear.sync.WearSyncScheduler
import app.calibratehealth.wear.tile.CalibrateTileUpdate
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Executes the phone-assisted handshake off the listener callback without retaining the service. */
class WearPairingListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        if (event.data.size > MAX_PAIRING_MESSAGE_BYTES) return
        if (
            event.path != PAIR_HELLO_PATH && event.path != PAIR_CREDENTIAL_PATH &&
            event.path != ACCOUNT_DISCONNECT_PATH
        ) return
        val path = event.path
        val nodeId = event.sourceNodeId.takeIf { it.isNotBlank() && it.length <= 256 } ?: return
        val payload = event.data.copyOf()
        val context = applicationContext
        try {
            executor.execute {
                when (path) {
                    PAIR_HELLO_PATH -> processInvite(context, nodeId, payload)
                    PAIR_CREDENTIAL_PATH -> processCredential(context, nodeId, payload)
                    ACCOUNT_DISCONNECT_PATH -> processAccountDisconnect(context, nodeId, payload)
                }
            }
        } catch (_: RejectedExecutionException) {
            PairingStateStore(context).setError("Pairing is busy. Start pairing again on your phone.")
        }
    }

    private companion object {
        val executor = ThreadPoolExecutor(
            1,
            1,
            30,
            TimeUnit.SECONDS,
            ArrayBlockingQueue(4),
            { runnable -> Thread(runnable, "calibrate-wear-pairing").apply { isDaemon = true } },
            ThreadPoolExecutor.AbortPolicy()
        ).apply { allowCoreThreadTimeOut(true) }

        fun processInvite(context: Context, nodeId: String, bytes: ByteArray) {
            val fields = parseFields(bytes) ?: return
            val invite = parsePhonePairingInvite(fields, BuildConfig.DEFAULT_SERVER_URL, System.currentTimeMillis())
                ?: return
            val stateStore = PairingStateStore(context)
            val keyManager = WearPairingKeyManager()
            val queuedResult = stateStore.readPendingResult()
            if (
                queuedResult != null && queuedResult.requestId == invite.requestId &&
                queuedResult.phoneNodeId == nodeId && queuedResult.serverOrigin == invite.serverOrigin
            ) {
                runCatching { sendMessage(context, nodeId, PAIR_RESULT_PATH, queuedResult.payload) }
                    .onSuccess { stateStore.clearPendingResult() }
                return
            }
            if (queuedResult != null) stateStore.clearPendingResult()
            val existing = stateStore.readPending()
            if (
                existing != null && existing.requestId == invite.requestId &&
                existing.phoneNodeId == nodeId && existing.serverOrigin == invite.serverOrigin &&
                existing.expiresAtEpochMs == invite.expiresAtEpochMs
            ) {
                val publicKey = keyManager.readPublicKey(existing.keyAlias) ?: run {
                    stateStore.setError("The pairing key was lost. Start pairing again on your phone.")
                    return
                }
                // Keep the durable request/key when the phone temporarily becomes unreachable.
                runCatching { sendPairingHello(context, existing, publicKey.spkiBase64) }
                return
            }
            existing?.let { old -> keyManager.deleteOwned(old.keyAlias) }
            try {
                val identity = WearDeviceIdentity(context)
                val publicKey = keyManager.createForRequest(invite.requestId)
                val pending = PendingPairingInvite(
                    requestId = invite.requestId,
                    phoneNodeId = nodeId,
                    serverOrigin = invite.serverOrigin,
                    expiresAtEpochMs = invite.expiresAtEpochMs,
                    watchDeviceId = identity.stableDeviceId(),
                    watchDeviceName = identity.displayName(),
                    keyAlias = publicKey.alias
                )
                stateStore.savePending(pending)
                sendPairingHello(context, pending, publicKey.spkiBase64)
            } catch (error: Exception) {
                stateStore.readPending()?.let { keyManager.deleteOwned(it.keyAlias) }
                stateStore.setError(safeError(error))
            }
        }

        fun processCredential(context: Context, nodeId: String, bytes: ByteArray) {
            val stateStore = PairingStateStore(context)
            val pending = stateStore.readPending() ?: return
            val fields = parseFields(bytes)
            val credential = fields?.let {
                parseWearPairingCredential(it, pending, nodeId, System.currentTimeMillis())
            }
            // A stale or foreign credential must not destroy the valid in-flight phone request.
            if (credential == null) return
            if (stateStore.consumePending(pending) == null) return

            val keyManager = WearPairingKeyManager()
            val resultPayload = try {
                val exchangeId = UUID.randomUUID().toString()
                val signature = keyManager.sign(
                    pending.keyAlias,
                    buildPairingSigningPayload(
                        credential.serverOrigin,
                        credential.watchDeviceId,
                        exchangeId,
                        credential.challenge
                    )
                )
                val session = runBlocking {
                    WearPairingHttpClient(
                        transport = pairingPhoneFirstHttpTransport(context, nodeId, credential.serverOrigin),
                        // The phone-first transport already includes one bounded direct failover.
                        maxTransportAttempts = 1
                    ).exchange(
                        PairingExchangeRequest(
                            pairingToken = credential.pairingToken,
                            serverOrigin = credential.serverOrigin,
                            watchDeviceId = credential.watchDeviceId,
                            exchangeId = exchangeId,
                            challengeSignature = signature
                        )
                    )
                }
                val coordinator = sessionCoordinator(context)
                // Notification state is account-scoped even though it is intentionally not stored in Room.
                WearReminderNotifier(context).clear()
                SyncInvalidationInbox.clear(context)
                runBlocking { coordinator.replace(session) }
                TrustedPhoneBindingStore(context).write(
                    TrustedPhoneBinding(
                        nodeId = nodeId,
                        serverOrigin = session.serverOrigin,
                        userId = session.userId,
                        watchDeviceId = session.watchDeviceId
                    ),
                    session
                )
                // Account replacement may have cleared Room; invalidate the remotely cached Tile
                // immediately so another account's summary is not retained while offline.
                CalibrateTileUpdate.request(context)
                stateStore.clearError()
                runCatching { WearSyncScheduler.scheduleAfterPairing(context) }
                buildPairingResult(pending)
            } catch (error: Exception) {
                val message = safeError(error)
                if (error is WearUpgradeRequiredException) {
                    stateStore.setUpgradeRequired(message)
                } else {
                    stateStore.setError(message)
                }
                buildPairingResult(pending, message)
            } finally {
                keyManager.deleteOwned(pending.keyAlias)
            }

            val pendingResult = PendingPairingResult(
                requestId = pending.requestId,
                phoneNodeId = pending.phoneNodeId,
                serverOrigin = pending.serverOrigin,
                expiresAtEpochMs = pending.expiresAtEpochMs,
                watchDeviceId = pending.watchDeviceId,
                payload = resultPayload
            )
            runCatching { stateStore.savePendingResult(pendingResult) }
            runCatching { sendMessage(context, pending.phoneNodeId, PAIR_RESULT_PATH, resultPayload) }
                .onSuccess { stateStore.clearPendingResult() }
            // A lost phone confirmation never discards a valid server-backed session.
            PairingStateEvents.notifyChanged()
        }

        fun processAccountDisconnect(context: Context, nodeId: String, bytes: ByteArray) {
            val tokenStore = AndroidKeystoreTokenStore(context)
            val session = runCatching { tokenStore.read() }.getOrNull() ?: return
            val binding = TrustedPhoneBindingStore(context).read(session) ?: return
            val fields = parseFields(bytes) ?: return
            val command = parsePhoneAccountDisconnect(
                fields = fields,
                sourceNodeId = nodeId,
                expectedNodeId = binding.nodeId,
                expectedServerOrigin = binding.serverOrigin,
                expectedUserId = binding.userId,
                expectedWatchDeviceId = binding.watchDeviceId,
                nowEpochMs = System.currentTimeMillis()
            ) ?: return
            val cleanup = runCatching { runBlocking { WearLocalDisconnect(context).disconnect().getOrThrow() } }
            if (cleanup.isSuccess) {
                // MessageClient delivery is insufficient; ACK only after the cleanup coordinator reports success.
                runCatching {
                    sendMessage(
                        context,
                        nodeId,
                        ACCOUNT_DISCONNECT_RESULT_PATH,
                        buildAccountDisconnectResult(command)
                    )
                }
            } else {
                PairingStateStore(context).setError(
                    "This account was deleted, but watch cleanup was incomplete. Retry local cleanup."
                )
            }
            PairingStateEvents.notifyChanged()
        }

        private fun sessionCoordinator(context: Context): AccountSessionCoordinator {
            val database = CalibrateWearDatabase.get(context)
            return AccountSessionCoordinator(
                AndroidKeystoreTokenStore(context),
                RoomAccountDataStore(database)
            )
        }

        private fun parseFields(bytes: ByteArray): PairingFields? = runCatching {
            JSONObject(bytes.toString(Charsets.UTF_8)).toPairingFields()
        }.getOrNull()

        private fun sendMessage(context: Context, nodeId: String, path: String, payload: String) {
            val bytes = payload.toByteArray(Charsets.UTF_8)
            require(bytes.size <= MAX_PAIRING_MESSAGE_BYTES) { "Pairing message is too large." }
            Tasks.await(
                Wearable.getMessageClient(context).sendMessage(nodeId, path, bytes),
                8,
                TimeUnit.SECONDS
            )
        }

        private fun sendPairingHello(
            context: Context,
            pending: PendingPairingInvite,
            publicKeySpki: String
        ) {
            val hello = JSONObject()
                .put("kind", "watch_pairing_hello")
                .put("request_id", pending.requestId)
                .put("protocol_version", WEAR_PAIRING_PROTOCOL_VERSION)
                .put("server_origin", pending.serverOrigin)
                .put("expires_at", java.time.Instant.ofEpochMilli(pending.expiresAtEpochMs).toString())
                .put("watch_device_id", pending.watchDeviceId)
                .put("watch_device_name", pending.watchDeviceName)
                .put("watch_public_key_spki", publicKeySpki)
                .toString()
            sendMessage(context, pending.phoneNodeId, PAIR_HELLO_PATH, hello)
        }

        private fun safeError(error: Exception): String = when (error) {
            is PairingExchangeException -> error.message ?: "Pairing failed. Start pairing again."
            else -> "Pairing failed. Start pairing again on your phone."
        }
    }
}

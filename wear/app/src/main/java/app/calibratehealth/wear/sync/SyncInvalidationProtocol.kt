/** Bounded versioned invalidation messages containing coordination identity rather than health summaries. */

package app.calibratehealth.wear.sync

import app.calibratehealth.wear.network.StrictJson
import app.calibratehealth.wear.network.requiredLong
import app.calibratehealth.wear.network.requiredString
import app.calibratehealth.wear.network.requireObject

internal data class SyncInvalidation(
    val id: String,
    val issuedAtEpochMs: Long,
    val expiresAtEpochMs: Long
)

internal data class ExpectedSyncInvalidationScope(
    val phoneNodeId: String,
    val serverOrigin: String,
    val userId: Long,
    val watchDeviceId: String
)

private const val PROTOCOL_VERSION = 1L
private const val MAX_INVALIDATION_BYTES = 4 * 1024
private const val MAX_INVALIDATION_TTL_MS = 10 * 60 * 1000L
private const val CLOCK_SKEW_MS = 60 * 1000L
internal val SYNC_INVALIDATION_ID = Regex("^[A-Za-z0-9-]{8,128}$")
private val INVALIDATION_FIELDS = setOf(
    "kind",
    "protocol_version",
    "invalidation_id",
    "server_origin",
    "user_id",
    "watch_device_id",
    "issued_at_epoch_ms",
    "expires_at_epoch_ms"
)

/** Rejects stale, cross-account, cross-origin, cross-device, and cross-node coordination. */
internal fun parseSyncInvalidation(
    payload: String,
    sourceNodeId: String,
    expected: ExpectedSyncInvalidationScope,
    nowEpochMs: Long
): SyncInvalidation? = runCatching {
    if (payload.toByteArray(Charsets.UTF_8).size > MAX_INVALIDATION_BYTES) return@runCatching null
    if (sourceNodeId != expected.phoneNodeId) return@runCatching null
    val root = StrictJson.parse(payload).requireObject("sync invalidation")
    if (root.values.keys != INVALIDATION_FIELDS) return@runCatching null
    if (root.requiredString("kind") != "sync_invalidation") return@runCatching null
    if (root.requiredLong("protocol_version") != PROTOCOL_VERSION) return@runCatching null
    if (root.requiredString("server_origin") != expected.serverOrigin) return@runCatching null
    if (root.requiredLong("user_id") != expected.userId) return@runCatching null
    if (root.requiredString("watch_device_id") != expected.watchDeviceId) return@runCatching null
    val id = root.requiredString("invalidation_id")
    if (!SYNC_INVALIDATION_ID.matches(id)) return@runCatching null
    val issuedAt = root.requiredLong("issued_at_epoch_ms")
    val expiresAt = root.requiredLong("expires_at_epoch_ms")
    if (issuedAt <= 0 || expiresAt <= issuedAt) return@runCatching null
    if (expiresAt - issuedAt > MAX_INVALIDATION_TTL_MS) return@runCatching null
    if (issuedAt > nowEpochMs + CLOCK_SKEW_MS || expiresAt <= nowEpochMs) return@runCatching null
    SyncInvalidation(id, issuedAt, expiresAt)
}.getOrNull()

internal fun boundedInvalidationIds(
    existing: List<String>,
    acceptedId: String,
    maximum: Int = 20
): List<String> {
    require(maximum > 0) { "Invalidation history bound must be positive." }
    return (existing.filter { SYNC_INVALIDATION_ID.matches(it) && it != acceptedId } + acceptedId)
        .takeLast(maximum)
}

/** Returns the next accepted-ID history only when the worker committed the ID it captured. */
internal fun completedInvalidationIds(
    pendingId: String?,
    capturedId: String?,
    acceptedIds: List<String>
): List<String>? {
    if (pendingId == null || capturedId == null || pendingId != capturedId) return null
    return boundedInvalidationIds(acceptedIds, pendingId)
}

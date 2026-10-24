/** Trusted-phone Data Layer handoff for opening richer phone logging surfaces. */

package app.calibratehealth.wear.actions

import android.content.Context
import app.calibratehealth.wear.WearDataLayerContract
import app.calibratehealth.wear.data.security.AndroidKeystoreTokenStore
import app.calibratehealth.wear.data.security.SecureSession
import app.calibratehealth.wear.pairing.TrustedPhoneBindingStore
import com.google.android.gms.wearable.Wearable
import java.nio.charset.StandardCharsets
import java.time.LocalDate

sealed interface ContinueOnPhoneRequest {
    data class FoodLog(val localDate: String) : ContinueOnPhoneRequest
    data object Privacy : ContinueOnPhoneRequest
    data object AccountDeletion : ContinueOnPhoneRequest
}

fun interface ContinueOnPhoneMessenger {
    /** Requests a bounded handoff to the trusted paired phone and reports transport success or failure. */
    fun send(request: ContinueOnPhoneRequest, onResult: (Result<Unit>) -> Unit)
}

/** Data Layer is used only to ask the paired phone to open a richer logging surface. */
class DataLayerContinueOnPhoneMessenger(context: Context) : ContinueOnPhoneMessenger {
    private val messageClient = Wearable.getMessageClient(context.applicationContext)
    private val tokenStore = AndroidKeystoreTokenStore(context.applicationContext)
    private val bindingStore = TrustedPhoneBindingStore(context.applicationContext)

    override fun send(request: ContinueOnPhoneRequest, onResult: (Result<Unit>) -> Unit) {
        val session = runCatching { tokenStore.read() }.getOrNull()
        if (session == null) {
            onResult(Result.failure(IllegalStateException("Pair the watch before continuing on the phone.")))
            return
        }
        val binding = runCatching { bindingStore.read(session) }.getOrNull()
        if (binding == null) {
            onResult(Result.failure(IllegalStateException("The paired phone binding is unavailable.")))
            return
        }
        val payload = runCatching {
            buildContinueOnPhonePayload(session, request).toByteArray(StandardCharsets.UTF_8)
        }.getOrElse { error ->
            onResult(Result.failure(error))
            return
        }
        messageClient.sendMessage(binding.nodeId, WearDataLayerContract.CONTINUE_ON_PHONE, payload)
            .addOnSuccessListener { onResult(Result.success(Unit)) }
            .addOnFailureListener { error -> onResult(Result.failure(error)) }
    }

}

/** Exact phone contract; binding the account prevents cross-scope handoff consumption. */
internal fun buildContinueOnPhonePayload(session: SecureSession, request: ContinueOnPhoneRequest): String {
    val accountScope = "{" +
        "\"protocol_version\":1," +
        "\"server_origin\":${jsonString(session.serverOrigin)}," +
        "\"user_id\":${session.userId},"
    return when (request) {
        is ContinueOnPhoneRequest.FoodLog -> {
            val parsedDate = runCatching { LocalDate.parse(request.localDate) }.getOrNull()
            require(parsedDate?.toString() == request.localDate) { "Handoff date must use YYYY-MM-DD." }
            accountScope +
                "\"destination\":\"food_log\"," +
                "\"local_date\":${jsonString(request.localDate)}" +
                "}"
        }
        ContinueOnPhoneRequest.Privacy -> accountScope + "\"destination\":\"privacy\"}"
        ContinueOnPhoneRequest.AccountDeletion -> accountScope + "\"destination\":\"account_deletion\"}"
    }
}

private fun jsonString(value: String): String = buildString {
    append('"')
    value.forEach { character ->
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
        }
    }
    append('"')
}

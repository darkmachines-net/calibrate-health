/** Stable watch device identity used by the pairing protocol. */

package app.calibratehealth.wear.pairing

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

internal class WearDeviceIdentity(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "calibrate_wear_device_identity",
        Context.MODE_PRIVATE
    )

    @Synchronized
    fun stableDeviceId(): String {
        preferences.getString(DEVICE_ID_KEY, null)?.let { return it }
        val generated = UUID.randomUUID().toString()
        check(preferences.edit().putString(DEVICE_ID_KEY, generated).commit()) {
            "Unable to persist stable Wear device ID."
        }
        return preferences.getString(DEVICE_ID_KEY, null) ?: generated
    }

    fun displayName(): String = "${Build.MANUFACTURER} ${Build.MODEL}"
        .trim()
        .ifBlank { "Wear OS watch" }
        .take(120)

    private companion object {
        const val DEVICE_ID_KEY = "watch_device_id"
    }
}

internal class WearPairingKeyManager {
    fun createForRequest(requestId: String): PairingPublicKey {
        val alias = aliasForRequest(requestId)
        delete(alias)
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        val publicKey = generator.generateKeyPair().public.encoded
        return PairingPublicKey(alias, Base64.encodeToString(publicKey, Base64.NO_WRAP))
    }

    fun sign(alias: String, payload: ByteArray): String {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val privateKey = keyStore.getKey(alias, null)
            ?: throw IllegalStateException("Pairing key is unavailable; start pairing again.")
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey as java.security.PrivateKey)
        signature.update(payload)
        return Base64.encodeToString(
            signature.sign(),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
    }

    /** Reuse the original public key when the phone retries the same unexpired invite. */
    fun readPublicKey(alias: String): PairingPublicKey? {
        if (!isOwnedAlias(alias)) return null
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val encoded = keyStore.getCertificate(alias)?.publicKey?.encoded ?: return null
        return PairingPublicKey(alias, Base64.encodeToString(encoded, Base64.NO_WRAP))
    }

    fun delete(alias: String) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    fun deleteOwned(alias: String) {
        if (isOwnedAlias(alias)) delete(alias)
    }

    private fun isOwnedAlias(alias: String): Boolean =
        alias.startsWith(KEY_ALIAS_PREFIX) && alias.length <= KEY_ALIAS_PREFIX.length + 24

    private fun aliasForRequest(requestId: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(requestId.toByteArray(Charsets.UTF_8))
        val suffix = Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        return "$KEY_ALIAS_PREFIX${suffix.take(24)}"
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS_PREFIX = "calibrate_wear_pairing_"
    }
}

internal data class PairingPublicKey(val alias: String, val spkiBase64: String)

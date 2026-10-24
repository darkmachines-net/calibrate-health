/** Keystore-encrypted session persistence bound to the configured server origin. */

package app.calibratehealth.wear.data.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.calibratehealth.wear.BuildConfig
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class SecureSession(
    val accessToken: String,
    val refreshToken: String,
    val userId: Long,
    val serverOrigin: String,
    val watchDeviceId: String,
    val accessExpiresAtEpochMs: Long,
    val refreshExpiresAtEpochMs: Long
)

/** Validates decrypted values independently of the authenticated-encryption envelope. */
internal fun SecureSession.requireValid() {
    require(accessToken.isNotBlank()) { "Access token cannot be blank." }
    require(refreshToken.isNotBlank()) { "Refresh token cannot be blank." }
    require(userId > 0) { "User ID must be positive." }
    require(watchDeviceId.isNotBlank()) { "Watch device ID cannot be blank." }
    require(accessExpiresAtEpochMs > 0) { "Access-token expiry must be positive." }
    require(refreshExpiresAtEpochMs >= accessExpiresAtEpochMs) {
        "Refresh-token expiry cannot precede access-token expiry."
    }
    ServerOriginPolicy.requireSafeOrigin(serverOrigin)
}

interface SecureTokenStore {
    /** Reads the encrypted session, returning null when absent and failing on corrupted credentials. */
    fun read(): SecureSession?
    /** Validates and persists the session in the secure token store. */
    fun write(session: SecureSession)
    /** Removes the persisted credential envelope. */
    fun clear()
}

class SecureTokenCorruptedException(message: String, cause: Throwable) : IllegalStateException(message, cause)

class AndroidKeystoreTokenStore(
    context: Context,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
    preferencesName: String = DEFAULT_PREFERENCES_NAME,
    private val expectedServerOrigin: String = BuildConfig.DEFAULT_SERVER_URL
) : SecureTokenStore {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    init {
        ServerOriginPolicy.requireSafeOrigin(expectedServerOrigin)
    }

    override fun read(): SecureSession? {
        val encoded = preferences.getString(SESSION_KEY, null) ?: return null
        return try {
            decodeSession(decrypt(Base64.decode(encoded, Base64.NO_WRAP))).also { session ->
                session.requireValid()
                require(session.serverOrigin == expectedServerOrigin) {
                    "Stored credential origin does not match this build's configured server."
                }
            }
        } catch (error: Exception) {
            throw SecureTokenCorruptedException(
                "Stored Wear session could not be decrypted; clear pairing and pair again.",
                error
            )
        }
    }

    override fun write(session: SecureSession) {
        session.requireValid()
        require(session.serverOrigin == expectedServerOrigin) {
            "Pairing credential origin does not match this build's configured server."
        }
        val encoded = Base64.encodeToString(encrypt(encodeSession(session)), Base64.NO_WRAP)
        check(preferences.edit().putString(SESSION_KEY, encoded).commit()) {
            "Unable to persist encrypted Wear session."
        }
    }

    override fun clear() {
        check(preferences.edit().remove(SESSION_KEY).commit()) { "Unable to clear encrypted Wear session." }
    }

    private fun encrypt(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        cipher.updateAAD(associatedData())
        val ciphertext = cipher.doFinal(plaintext)
        return ByteBuffer.allocate(Int.SIZE_BYTES + cipher.iv.size + ciphertext.size)
            .putInt(cipher.iv.size)
            .put(cipher.iv)
            .put(ciphertext)
            .array()
    }

    private fun decrypt(payload: ByteArray): ByteArray {
        val buffer = ByteBuffer.wrap(payload)
        val ivLength = buffer.int
        require(ivLength in 12..16 && buffer.remaining() > ivLength) { "Invalid encrypted session envelope." }
        val iv = ByteArray(ivLength).also { buffer.get(it) }
        val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(associatedData())
        return cipher.doFinal(ciphertext)
    }

    @Synchronized
    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
    }

    private fun associatedData(): ByteArray =
        "${appContext.packageName}:$keyAlias:$expectedServerOrigin:v2".toByteArray(Charsets.UTF_8)

    private fun encodeSession(session: SecureSession): ByteArray = JSONObject()
        .put("access_token", session.accessToken)
        .put("refresh_token", session.refreshToken)
        .put("user_id", session.userId)
        .put("server_origin", session.serverOrigin)
        .put("watch_device_id", session.watchDeviceId)
        .put("access_expires_at_epoch_ms", session.accessExpiresAtEpochMs)
        .put("refresh_expires_at_epoch_ms", session.refreshExpiresAtEpochMs)
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun decodeSession(value: ByteArray): SecureSession = JSONObject(value.toString(Charsets.UTF_8)).let { json ->
        SecureSession(
            accessToken = json.getString("access_token"),
            refreshToken = json.getString("refresh_token"),
            userId = json.getLong("user_id"),
            serverOrigin = json.getString("server_origin"),
            watchDeviceId = json.getString("watch_device_id"),
            accessExpiresAtEpochMs = json.getLong("access_expires_at_epoch_ms"),
            refreshExpiresAtEpochMs = json.getLong("refresh_expires_at_epoch_ms")
        )
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val DEFAULT_KEY_ALIAS = "calibrate_wear_session_v2"
        private const val DEFAULT_PREFERENCES_NAME = "calibrate_wear_secure_session"
        private const val SESSION_KEY = "encrypted_session_v2"
    }
}

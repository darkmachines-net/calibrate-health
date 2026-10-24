/** Origin-only server validation with explicit trusted-development cleartext restrictions. */

package app.calibratehealth.wear.data.security

import java.net.URI

object ServerOriginPolicy {
    /** Validates an origin-only server URL and rejects unsafe schemes, credentials, paths, and ports. */
    fun requireSafeOrigin(value: String): String {
        val uri = runCatching { URI(value) }.getOrElse {
            throw IllegalArgumentException("Server origin is invalid.", it)
        }
        val host = uri.host ?: throw IllegalArgumentException("Server origin must include a host.")
        require(
            uri.userInfo == null &&
                uri.rawPath.isNullOrEmpty() &&
                uri.rawQuery == null &&
                uri.rawFragment == null &&
                (uri.port == -1 || uri.port in 1..65535)
        ) { "Server origin cannot include credentials, a path, query, fragment, or invalid port." }

        return when (uri.scheme?.lowercase()) {
            "https" -> value
            "http" -> {
                require(privateOrLocalHost(host)) { "Public server origins require HTTPS." }
                value
            }
            else -> throw IllegalArgumentException("Server origin must use HTTPS or private HTTP.")
        }
    }

    private fun privateOrLocalHost(rawHost: String): Boolean {
        val host = rawHost.lowercase().removePrefix("[").removeSuffix("]").substringBefore('%')
        if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true

        val ipv4 = host.split('.').mapNotNull { it.toIntOrNull() }
        if (ipv4.size == 4 && ipv4.all { it in 0..255 }) {
            return ipv4[0] == 10 ||
                ipv4[0] == 127 ||
                (ipv4[0] == 172 && ipv4[1] in 16..31) ||
                (ipv4[0] == 192 && ipv4[1] == 168)
        }

        if (host == "::1") return true
        val firstGroup = host.substringBefore(':').toIntOrNull(16) ?: return false
        return firstGroup in 0xfc00..0xfdff || firstGroup in 0xfe80..0xfebf
    }
}

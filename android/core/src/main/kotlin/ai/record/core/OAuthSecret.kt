package ai.record.core

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** The secret behind "Continue with …" on this phone (PKCE). */
object OAuthSecret {
    private val random = SecureRandom()
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun make(): String = ByteArray(32).also(random::nextBytes).let(encoder::encodeToString)

    fun challenge(verifier: String): String =
        encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

    /** The query of recordai://auth?code=… as a map. */
    fun query(uri: String): Map<String, String> =
        (runCatching { URI(uri).rawQuery }.getOrNull() ?: "").split("&").filter { "=" in it }.associate {
            val (k, v) = it.split("=", limit = 2)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }
}

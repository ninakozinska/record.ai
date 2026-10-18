package ai.record.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiException(val status: Int, message: String) : Exception(message) {
    companion object {
        fun offline() = ApiException(0, "Cannot reach your record.ai server. Is your computer on, with record.ai running?")
    }
}

/**
 * Talks to the record.ai server. One shared OkHttpClient reuses connections
 * and transparently asks for gzip-compressed answers.
 */
class Api(val baseUrl: String, private val token: String?, private val client: OkHttpClient = sharedClient) {

    companion object {
        val sharedClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        // The server pings every 25 s; 70 s without data means the stream is dead.
        private val liveClient: OkHttpClient = sharedClient.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()

        private val JSON_TYPE = "application/json".toMediaType()

        /** Turns what the person typed ("192.168.1.20:3000") into a server address, or null. */
        fun normalize(input: String): String? {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (!s.startsWith("http://", ignoreCase = true) && !s.startsWith("https://", ignoreCase = true)) s = "http://$s"
            return s.toHttpUrlOrNull()?.toString()?.trimEnd('/')
        }
    }

    private fun url(path: String) = "$baseUrl/api/$path"

    private suspend fun call(path: String, method: String = "GET", body: RequestBody? = null): ByteArray {
        val request = Request.Builder().url(url(path)).apply {
            token?.let { header("Authorization", "Bearer $it") }
            method(method, body ?: if (method == "GET") null else ByteArray(0).toRequestBody(JSON_TYPE))
        }.build()
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw ApiException.offline()
        }
        return response.use { res ->
            val bytes = withContext(Dispatchers.IO) { res.body?.bytes() ?: ByteArray(0) }
            if (!res.isSuccessful) {
                val message = runCatching { json.parseToJsonElement(bytes.decodeToString()).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
                throw ApiException(res.code, message ?: "Something went wrong (${res.code}).")
            }
            bytes
        }
    }

    private suspend fun post(path: String, body: JsonElement): ByteArray =
        call(path, "POST", json.encodeToString(JsonElement.serializer(), body).toRequestBody(JSON_TYPE))

    private inline fun <reified T> decode(bytes: ByteArray): T = json.decodeFromString(bytes.decodeToString())

    suspend fun checkServer() {
        val ok = runCatching { json.parseToJsonElement(call("health").decodeToString()).jsonObject["ok"]?.jsonPrimitive?.content }.getOrNull()
        if (ok != "true") throw ApiException(0, "That address answers, but it isn't a record.ai server.")
    }

    suspend fun authState(): AuthState = decode(call("auth/state"))

    suspend fun login(email: String, password: String): AuthResult =
        decode(post("auth/login", buildJsonObject { put("email", email); put("password", password) }))

    suspend fun signup(name: String, email: String, password: String, code: String): AuthResult =
        decode(post("auth/signup", buildJsonObject { put("name", name); put("email", email); put("password", password); put("code", code) }))

    suspend fun logout() { post("auth/logout", JsonObject(emptyMap())) }

    suspend fun changePassword(current: String, next: String) {
        post("auth/password", buildJsonObject { put("current", current); put("next", next) })
    }

    suspend fun logoutOthers() { post("auth/logout-others", JsonObject(emptyMap())) }

    suspend fun notes(since: Long): NotesPage = decode(call("notes?since=$since"))

    /** One round trip: send every change, get back everything changed since `since`. */
    suspend fun sync(since: Long, changes: List<JsonObject>): SyncResponse =
        decode(post("sync", buildJsonObject {
            put("since", since)
            put("changes", kotlinx.serialization.json.JsonArray(changes))
        }))

    suspend fun putImage(name: String, bytes: ByteArray, thumb: Boolean) {
        call("images/$name" + if (thumb) "?variant=thumb" else "", "PUT", bytes.toRequestBody("image/jpeg".toMediaType()))
    }

    suspend fun image(name: String, thumb: Boolean): ByteArray = call("images/$name" + if (thumb) "?variant=thumb" else "")

    suspend fun reanalyze(id: String) { post("notes/$id/reanalyze", JsonObject(emptyMap())) }

    suspend fun reorganize(): ReorganizeResult = decode(post("reorganize", JsonObject(emptyMap())))

    /** Live updates (Server-Sent Events). Call `cancel()` on the result to stop. */
    fun events(onEvent: (type: String, data: String) -> Unit, onClosed: (Throwable?, Int?) -> Unit): EventSource {
        val request = Request.Builder().url(url("events")).apply {
            token?.let { header("Authorization", "Bearer $it") }
        }.build()
        return EventSources.createFactory(liveClient).newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) = onEvent(type ?: "message", data)
            override fun onClosed(eventSource: EventSource) = onClosed(null, null)
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) = onClosed(t, response?.code)
        })
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
    })
}

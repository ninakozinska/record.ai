package ai.record.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
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
        /**
         * A computer at home (an IP address, "localhost", a ".local" name, or anything
         * with a port such as :3000) speaks plain http; a server on the internet
         * (record-ai-nina.fly.dev) only https. A login sent over http to such a server
         * is redirected and loses its password, so guessing right matters.
         */
        internal fun isLocal(address: String): Boolean {
            val host = address.substringBefore('/')
            val name = host.substringBefore(':')
            return ':' in host || name == "localhost" || name.endsWith(".local") ||
                Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(name)
        }

        fun normalize(input: String): String? {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (!s.startsWith("http://", ignoreCase = true) && !s.startsWith("https://", ignoreCase = true)) {
                s = (if (isLocal(s)) "http://" else "https://") + s
            }
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

    /** Emails a link to choose a new password (opens in the browser). Same answer whether the account exists or not. */
    suspend fun forgotPassword(email: String) { post("auth/forgot", buildJsonObject { put("email", email) }) }

    suspend fun changePassword(current: String, next: String) {
        post("auth/password", buildJsonObject { put("current", current); put("next", next) })
    }

    suspend fun logoutOthers() { post("auth/logout-others", JsonObject(emptyMap())) }

    /** Trades the one-time code from "Continue with …" (plus this app's secret) for a login. */
    suspend fun oauthExchange(code: String, verifier: String): AuthResult =
        decode(post("auth/oauth/exchange", buildJsonObject { put("code", code); put("verifier", verifier) }))

    suspend fun accountInfo(): AccountInfo = decode(call("auth/me"))

    suspend fun disconnect(provider: String) { call("auth/identities/$provider", "DELETE") }

    suspend fun notes(since: Long): NotesPage = decode(call("notes?since=$since&items=1&shared=1"))

    /** One round trip: send every change, get back everything changed since `since`. */
    suspend fun sync(since: Long, changes: List<JsonObject>): SyncResponse =
        decode(post("sync", buildJsonObject {
            put("since", since)
            put("items", true)
            put("shared", true)
            put("changes", kotlinx.serialization.json.JsonArray(changes))
        }))

    suspend fun putImage(name: String, bytes: ByteArray, thumb: Boolean) {
        call("images/$name" + if (thumb) "?variant=thumb" else "", "PUT", bytes.toRequestBody("image/jpeg".toMediaType()))
    }

    suspend fun image(name: String, thumb: Boolean): ByteArray = call("images/$name" + if (thumb) "?variant=thumb" else "")

    suspend fun reanalyze(id: String) { post("notes/$id/reanalyze", JsonObject(emptyMap())) }

    /** The people tasks can be for. */
    suspend fun people(): People = decode(call("people"))

    /** "Turn into tasks": the things to do in a note's text and photos become notes. */
    suspend fun extractTasks(id: String): TasksResult = decode(post("notes/$id/tasks", JsonObject(emptyMap())))

    suspend fun reorganize(): ReorganizeResult = decode(post("reorganize", JsonObject(emptyMap())))

    // --- sharing ---

    suspend fun shares(): Shares = decode(call("shares"))

    /** kind: "note" (a note or list, by id) or "group" (by name); role: "edit" or "view". */
    suspend fun share(kind: String, target: String, email: String, role: String) {
        post("shares", buildJsonObject { put("kind", kind); put("target", target); put("email", email); put("role", role) })
    }

    suspend fun setShareRole(id: String, role: String) {
        call("shares/$id", "PATCH", json.encodeToString(JsonElement.serializer(), buildJsonObject { put("role", role) }).toRequestBody(JSON_TYPE))
    }

    /** Stop sharing (the owner), or leave a note shared with me. */
    suspend fun unshare(id: String) { call("shares/$id", "DELETE") }

    @kotlinx.serialization.Serializable private data class WorldChoices(val chosen: Map<String, String> = emptyMap())

    /** Groups the person moved between Work and Family ("" = both). */
    suspend fun worlds(): Map<String, String> = decode<WorldChoices>(call("groups/worlds")).chosen

    // --- plan, backups, account ---

    suspend fun plan(): Plan = decode(call("plan"))

    @kotlinx.serialization.Serializable private data class BackupList(val backups: List<Backup> = emptyList())

    suspend fun backups(): List<Backup> = decode<BackupList>(call("backups")).backups

    suspend fun backupNow() { post("backups", JsonObject(emptyMap())) }

    suspend fun restore(id: String) { post("backups/$id/restore", JsonObject(emptyMap())) }

    /** Deletes the account and everything in it. `email` must be the account's, to confirm. */
    suspend fun deleteAccount(email: String) { post("account/delete", buildJsonObject { put("email", email) }) }

    // --- A/B tests and events (see docs/OPTIMIZATION.md); work before logging in too ---

    /** The variant of every running A/B test for this device or account. */
    suspend fun experiments(anonId: String): Map<String, String> {
        val answer = json.parseToJsonElement(call("public/experiments?anon=$anonId&platform=android").decodeToString()).jsonObject
        return answer["variants"]?.jsonObject?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap()
    }

    /** Sends events (what people do, never what they write); at most 50 per call. */
    suspend fun sendEvents(anonId: String, events: List<JsonObject>) {
        post("public/events", buildJsonObject {
            put("anon", anonId)
            put("platform", "android")
            put("events", JsonArray(events))
        })
    }

    /** Live updates (Server-Sent Events). Call `cancel()` on the result to stop. */
    fun events(onEvent: (type: String, data: String) -> Unit, onClosed: (Throwable?, Int?) -> Unit): EventSource {
        val request = Request.Builder().url(url("events?items=1&shared=1")).apply {
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

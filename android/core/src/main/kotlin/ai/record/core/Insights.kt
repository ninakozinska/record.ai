package ai.record.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * A/B tests and events for the Android app, the same tests as the web app
 * (see docs/OPTIMIZATION.md). `anonId` is a random id kept on the phone
 * (newAnonId() once, then stored); the server links it to the account at login.
 * Events carry counts and choices only, never note contents.
 */
class Insights(val anonId: String, private val api: () -> Api?) {
    private val queue = mutableListOf<JsonObject>()
    private var variants: Map<String, String> = emptyMap()

    /** Fetches this device's variants; offline, every test shows its first variant. */
    suspend fun load() {
        val a = api() ?: return
        runCatching { variants = a.experiments(anonId) }
    }

    fun variant(key: String, fallback: String): String = variants[key] ?: fallback

    fun track(name: String, props: Map<String, String> = emptyMap()) {
        val event = buildJsonObject {
            put("name", name)
            put("ts", System.currentTimeMillis())
            put("props", buildJsonObject { props.forEach { (k, v) -> put(k, v) } })
        }
        synchronized(queue) { queue += event }
    }

    /** Sends what is waiting; call it on a timer and when the app goes to the background. */
    suspend fun flush() {
        val a = api() ?: return
        val batch = synchronized(queue) { queue.take(50).also { repeat(it.size) { queue.removeAt(0) } } }
        if (batch.isEmpty()) return
        runCatching { a.sendEvents(anonId, batch) }.onFailure { synchronized(queue) { queue.addAll(0, batch) } }
    }

    fun pending(): Int = synchronized(queue) { queue.size }

    companion object {
        fun newAnonId(): String = UUID.randomUUID().toString()
    }
}

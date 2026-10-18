package ai.record.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

enum class Priority(val label: String) {
    URGENT("Urgent"), HIGH("High"), NORMAL("Normal"), LOW("Low");

    val key: String get() = name.lowercase()

    companion object {
        fun of(key: String?): Priority? = entries.firstOrNull { it.key == key }
    }
}

/** A note as the server sends it (see docs/API.md). Times are milliseconds since 1970. */
@Serializable
data class Note(
    val id: String,
    val text: String = "",
    val images: List<String> = emptyList(),
    val done: Boolean = false,
    val deleted: Boolean = false,
    @SerialName("created_at") val createdAt: Double = 0.0,
    @SerialName("edited_at") val editedAt: Double = 0.0,
    @SerialName("user_group") val userGroup: String? = null,
    @SerialName("user_priority") val userPriority: String? = null,
    val title: String? = null,
    val summary: String? = null,
    @SerialName("ai_group") val aiGroup: String? = null,
    @SerialName("ai_priority") val aiPriority: String? = null,
    @SerialName("priority_reason") val priorityReason: String? = null,
    val tags: List<String>? = null,
    @SerialName("due_date") val dueDate: String? = null,
    @SerialName("ai_status") val aiStatus: String? = null,
    @SerialName("ai_error") val aiError: String? = null,
    val rev: Long? = null,
) {
    /** The person's group if they chose one, else the AI's, else "Inbox". */
    val group: String get() = userGroup?.takeIf { it.isNotBlank() } ?: aiGroup?.takeIf { it.isNotBlank() } ?: "Inbox"

    val priority: Priority get() = Priority.of(userPriority) ?: Priority.of(aiPriority) ?: Priority.NORMAL

    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: text.lineSequence().firstOrNull { it.isNotBlank() }?.take(80)
            ?: if (images.isEmpty()) "Untitled" else "Photo"

    /** Text under the title; skips the first line when that line is the title. */
    val preview: String
        get() = (if (title != null) text else text.lines().drop(1).joinToString("\n")).trim()
}

@Serializable data class User(val id: String, val name: String, val email: String) {
    val initials: String get() = name.split(" ").filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }
}

@Serializable data class SignupPolicy(val open: Boolean, val needsCode: Boolean, val firstAccount: Boolean)

@Serializable data class AuthState(val user: User? = null, val signup: SignupPolicy)

@Serializable data class AuthResult(val token: String, val user: User)

@Serializable data class AiStatus(
    val enabled: Boolean,
    val provider: String? = null,
    val model: String? = null,
    val reorganizing: Boolean? = null,
)

@Serializable data class SyncItemResult(val id: String? = null, val status: String, val error: String? = null)

@Serializable data class SyncResponse(val rev: Long, val results: List<SyncItemResult>, val notes: List<Note>)

@Serializable data class NotesPage(val rev: Long, val notes: List<Note>)

@Serializable data class ReorganizeResult(val updated: Int? = null, val skipped: Boolean? = null)

/** A change waiting to be sent. `body` holds the changed note fields, as the server names them. */
@Serializable data class OutboxItem(val kind: String, val id: String, val body: JsonObject? = null) {
    companion object {
        const val NOTE = "note"
        const val IMAGE = "image"
    }
}

/** Everything kept on the phone between launches. */
@Serializable data class CacheState(
    val userId: String? = null,
    val rev: Long = 0,
    val notes: List<Note> = emptyList(),
    val outbox: List<OutboxItem> = emptyList(),
)

internal val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

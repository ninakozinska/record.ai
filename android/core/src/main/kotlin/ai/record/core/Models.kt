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

/** Where notes shared with me appear (their groups are the owner's). */
const val SHARED_GROUP = "Shared with me"

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
    @SerialName("due_time") val dueTime: String? = null,
    /** The person's date: null = the AI decides, "" = no date, "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". */
    @SerialName("user_due") val userDue: String? = null,
    @SerialName("ai_due_date") val aiDueDate: String? = null,
    @SerialName("ai_due_time") val aiDueTime: String? = null,
    /** A list item: the id of its list. Items go one level deep. */
    @SerialName("parent_id") val parentId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    /** Set on notes shared with me: "edit" or "view". */
    val role: String? = null,
    @SerialName("owner_name") val ownerName: String? = null,
    /** I can no longer see this note: remove it from the device. */
    val revoked: Boolean = false,
    @SerialName("ai_status") val aiStatus: String? = null,
    @SerialName("ai_error") val aiError: String? = null,
    val rev: Long? = null,
    /** Reminder: minutes before the note's time (0 = at the time); null = none. */
    val remind: Int? = null,
    /** Family hub: who the note or item is for, and who ticked it off (account ids). */
    @SerialName("assigned_to") val assignedTo: String? = null,
    @SerialName("done_by") val doneBy: String? = null,
) {
    /** The person's group if they chose one, else the AI's, else "Inbox". */
    val group: String get() = if (role != null) SHARED_GROUP else userGroup?.takeIf { it.isNotBlank() } ?: aiGroup?.takeIf { it.isNotBlank() } ?: "Inbox"

    val priority: Priority get() = Priority.of(userPriority) ?: Priority.of(aiPriority) ?: Priority.NORMAL

    /** Shared with me by someone else. */
    val shared: Boolean get() = role != null
    val canEdit: Boolean get() = role != "view"

    /** The date shown: the person's if they chose one (or chose none), else the AI's. */
    val due: String?
        get() = if (userDue != null) userDue.take(10).ifBlank { null } else aiDueDate ?: dueDate
    val time: String?
        get() = if (userDue != null) userDue.drop(11).take(5).ifBlank { null } else aiDueTime ?: dueTime

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

@Serializable data class AuthState(
    val user: User? = null,
    val signup: SignupPolicy,
    /** "Continue with Google / Apple / …" options set up on the server. */
    val providers: List<AuthProvider> = emptyList(),
)

@Serializable data class AuthProvider(val id: String, val name: String)

/** How this account can log in (the account screen). */
@Serializable data class AccountInfo(val hasPassword: Boolean, val identities: List<Identity> = emptyList()) {
    @Serializable data class Identity(val provider: String, val name: String, val email: String? = null)
}

@Serializable data class AuthResult(val token: String, val user: User)

/** Someone tasks can be for: me, or a person I share with. */
@Serializable data class Person(val id: String, val name: String, val me: Boolean = false)
@Serializable data class People(val people: List<Person> = emptyList(), val family: Boolean = false)

/** The notes made from a letter or photo ("Turn into tasks"). */
@Serializable data class TasksResult(val ids: List<String> = emptyList())

@Serializable data class AiStatus(
    val enabled: Boolean,
    val provider: String? = null,
    val model: String? = null,
    val reorganizing: Boolean? = null,
)

@Serializable data class SyncItemResult(val id: String? = null, val status: String, val error: String? = null)

@Serializable data class SyncResponse(val rev: Long, val results: List<SyncItemResult>, val notes: List<Note>)

@Serializable data class NotesPage(val rev: Long, val notes: List<Note>)

/** A share I made, or one made with me. */
@Serializable data class Share(
    val id: String,
    val kind: String,
    val target: String,
    val role: String,
    val email: String? = null,
    val name: String? = null,
    val owner: User? = null,
)

@Serializable data class Shares(val mine: List<Share> = emptyList(), val withMe: List<Share> = emptyList())

@Serializable data class Plan(val plan: String = "free", val premium: Boolean = false)

@Serializable data class Backup(val id: String, val kind: String, @SerialName("created_at") val createdAt: Double, val notes: Int = 0)

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

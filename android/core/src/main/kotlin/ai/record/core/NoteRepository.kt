package ai.record.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import okhttp3.sse.EventSource
import java.util.UUID

/** What the screens show. */
data class UiState(
    val serverUrl: String? = null,
    val user: User? = null,
    val signup: SignupPolicy? = null,
    val providers: List<AuthProvider> = emptyList(),
    val notes: Map<String, Note> = emptyMap(),
    val online: Boolean = false,
    val unsent: Int = 0,
    val ai: AiStatus? = null,
) {
    val loggedIn: Boolean get() = user != null
    val aiEnabled: Boolean get() = ai?.enabled ?: true
    /** Notes and lists (not the items inside lists). */
    val visible: List<Note> get() = notes.values.filter { !it.deleted && it.parentId == null }

    /** A list's items: open ones first, most urgent first, then in the order they were added. */
    fun items(listId: String): List<Note> = notes.values.filter { it.parentId == listId && !it.deleted }
        .sortedWith(compareBy<Note> { it.done }.thenBy { it.priority.ordinal }.thenBy { it.createdAt })

    /** Groups of open notes, biggest first. */
    val groupNames: List<String>
        get() = visible.filter { !it.done }.groupingBy { it.group }.eachCount()
            .entries.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key }).map { it.key }
}

/** Most urgent first; then by due date; then newest first. */
val noteOrder: Comparator<Note> = compareBy<Note> { it.priority.ordinal }
    .thenBy(nullsLast()) { it.due?.let { d -> d + (it.time ?: "") } }
    .thenByDescending { it.createdAt }

/**
 * Keeps notes on the device and in sync with the server. The rules are the
 * same in the web and iPhone apps (docs/DEVELOPMENT.md, "Sync rules"):
 *  - every edit is saved locally and queued in an outbox (nothing is lost offline);
 *  - photos are uploaded first, then all note changes go in ONE /api/sync request,
 *    which also returns everything that changed on the server;
 *  - edits made while sending are sent right after;
 *  - a server note with a lower revision than ours is ignored (no going backwards);
 *  - live updates arrive over Server-Sent Events while the app is open.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NoteRepository(
    private val storage: Storage,
    private val secrets: SecretStore,
    private val scope: CoroutineScope,
    private val now: () -> Double = { System.currentTimeMillis().toDouble() },
) {
    // All state changes run one at a time on this dispatcher: no locks needed.
    private val confined = Dispatchers.Default.limitedParallelism(1)

    private val _state = MutableStateFlow(UiState(serverUrl = storage.serverUrl, user = storage.user))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var rev = 0L
    private var outbox = listOf<OutboxItem>()
    private var cachedUserId: String? = null
    private var flushing = false
    private var flushAgain = false
    private var live: EventSource? = null
    private var liveWanted = false
    private var persistJob: Job? = null

    init {
        storage.loadCache()?.let { c ->
            rev = c.rev
            outbox = c.outbox
            cachedUserId = c.userId
            _state.update { it.copy(notes = c.notes.associateBy(Note::id), unsent = c.outbox.size) }
        }
        if (secrets.token == null && _state.value.user != null) setUser(null)
    }

    private val api: Api? get() = _state.value.serverUrl?.let { Api(it, secrets.token) }

    // ---------------------------------------------------------------- saving

    /** Saves to disk shortly after the last change (many quick edits = one write). */
    private fun persistSoon() {
        val snapshot = CacheState(cachedUserId, rev, _state.value.notes.values.toList(), outbox)
        _state.update { it.copy(unsent = outbox.size) }
        persistJob?.cancel()
        persistJob = scope.launch(Dispatchers.IO) {
            delay(300)
            storage.saveCache(snapshot)
        }
    }

    private suspend fun persistNow() = withContext(Dispatchers.IO) {
        persistJob?.cancel()
        storage.saveCache(CacheState(cachedUserId, rev, _state.value.notes.values.toList(), outbox))
    }

    private fun wipe() {
        rev = 0
        outbox = emptyList()
        cachedUserId = null
        _state.update { it.copy(notes = emptyMap(), unsent = 0) }
        persistJob?.cancel()
        storage.clearData()
    }

    private fun setUser(user: User?) {
        storage.user = user
        _state.update { it.copy(user = user) }
    }

    // ------------------------------------------------------- server & account

    suspend fun connect(input: String) = withContext(confined) {
        val url = Api.normalize(input) ?: throw ApiException(0, "Please enter the address shown in the web app.")
        Api(url, null).checkServer()
        storage.serverUrl = url
        _state.update { it.copy(serverUrl = url) }
        runCatching { refreshAuthState() }
    }

    suspend fun forgetServer() = withContext(confined) {
        stopLiveNow()
        storage.serverUrl = null
        secrets.token = null
        setUser(null)
        wipe()
        _state.update { it.copy(serverUrl = null, signup = null) }
    }

    suspend fun refreshAuthState() = withContext(confined) {
        val api = api ?: return@withContext
        val s = api.authState()
        _state.update { it.copy(signup = s.signup, providers = s.providers) }
        if (s.user == null && secrets.token != null) {
            // Our session ended (password changed, logged out elsewhere).
            secrets.token = null
            setUser(null)
        }
    }

    suspend fun login(email: String, password: String) {
        val api = api ?: return
        signedIn(api.login(email.trim(), password))
    }

    suspend fun signup(name: String, email: String, password: String, code: String) {
        val api = api ?: return
        signedIn(api.signup(name.trim(), email.trim(), password, code.trim()))
    }

    /**
     * Where to start "Continue with …" in the browser. The secret stays on the
     * phone; the server only lets the one who holds it finish the sign-in.
     */
    fun socialLoginUrl(provider: String, invite: String = ""): String? {
        val server = _state.value.serverUrl ?: return null
        val verifier = OAuthSecret.make()
        secrets.oauthVerifier = verifier
        val q = buildString {
            append("app=").append(OAuthSecret.challenge(verifier))
            if (invite.isNotBlank()) append("&invite=").append(java.net.URLEncoder.encode(invite.trim(), "UTF-8"))
        }
        return "$server/api/auth/oauth/${java.net.URLEncoder.encode(provider, "UTF-8")}/start?$q"
    }

    /** The browser came back to recordai://auth?code=… (or ?error=…). */
    suspend fun socialLoginFinish(callback: String) {
        val api = api ?: return
        val query = OAuthSecret.query(callback)
        query["error"]?.let { throw ApiException(400, it) }
        val code = query["code"] ?: throw ApiException(400, "Sign-in didn't finish. Please try again.")
        val verifier = secrets.oauthVerifier ?: throw ApiException(400, "Sign-in expired. Please try again.")
        secrets.oauthVerifier = null
        signedIn(api.oauthExchange(code, verifier))
    }

    suspend fun accountInfo(): AccountInfo? = api?.accountInfo()

    suspend fun disconnect(provider: String) { api?.disconnect(provider) }

    private suspend fun signedIn(result: AuthResult) = withContext(confined) {
        if (cachedUserId != null && cachedUserId != result.user.id) wipe()
        cachedUserId = result.user.id
        secrets.token = result.token
        setUser(result.user)
        persistNow()
        start()
    }

    /** Logs out and removes this account's notes from the device. */
    suspend fun logout() = withContext(confined) {
        stopLiveNow()
        runCatching { api?.logout() }
        secrets.token = null
        setUser(null)
        wipe()
        runCatching { refreshAuthState() }
    }

    suspend fun forgotPassword(email: String) { (api ?: throw ApiException.offline()).forgotPassword(email.trim()) }

    suspend fun changePassword(current: String, next: String) { api?.changePassword(current, next) }

    suspend fun logoutOtherDevices() { api?.logoutOthers() }

    private fun handleUnauthorized(e: Throwable) {
        if (e is ApiException && e.status == 401) {
            stopLiveNow()
            secrets.token = null
            setUser(null)
            _state.update { it.copy(online = false) }
        }
    }

    // ------------------------------------------------------------------ sync

    /** Call when the app comes to the foreground. */
    fun start() {
        if (secrets.token == null) return
        liveWanted = true
        scope.launch(confined) {
            flush()
            connectLive()
        }
    }

    /** Call when the app goes to the background: live updates stop (saves battery). */
    fun stopLive() { scope.launch(confined) { stopLiveNow() } }

    private fun stopLiveNow() {
        liveWanted = false
        live?.cancel()
        live = null
    }

    private fun connectLive() {
        if (!liveWanted || live != null) return
        val api = api ?: return
        live = api.events(
            onEvent = { type, data -> scope.launch(confined) { onLiveEvent(type, data) } },
            onClosed = { error, status ->
                scope.launch(confined) {
                    live = null
                    _state.update { it.copy(online = false) }
                    if (status == 401) return@launch handleUnauthorized(ApiException(401, "Login required"))
                    if (error != null || liveWanted) {
                        delay(5_000)
                        if (liveWanted) { flush(); connectLive() }
                    }
                }
            },
        )
    }

    private suspend fun onLiveEvent(type: String, data: String) {
        _state.update { it.copy(online = true) }
        when (type) {
            "note" -> runCatching { json.decodeFromString(Note.serializer(), data) }.getOrNull()?.let { merge(listOf(it)) }
            "hello" -> {
                val ai = runCatching { json.decodeFromString(Hello.serializer(), data).ai }.getOrNull()
                _state.update { it.copy(ai = ai) }
                flush() // also brings back what changed while we were away
            }
            "shares" -> flush() // something was shared with me, or stopped being shared
            "status" -> {
                val ai = runCatching { json.decodeFromString(AiStatus.serializer(), data) }.getOrNull()
                _state.update { it.copy(ai = ai) }
            }
        }
    }

    @kotlinx.serialization.Serializable private data class Hello(val ai: AiStatus)

    /** Merges notes from the server; unsent local edits keep their text and choices. */
    internal fun merge(incoming: List<Note>) {
        if (incoming.isEmpty()) return
        val pending = outbox.filter { it.kind == OutboxItem.NOTE }.map { it.id }.toSet()
        val notes = _state.value.notes.toMutableMap()
        for (s in incoming) {
            if (s.revoked) {
                // No longer shared with me: it (and its items) leave this device.
                notes.remove(s.id)
                notes.values.filter { it.parentId == s.id }.forEach { notes.remove(it.id) }
                outbox = outbox.filterNot { it.kind == OutboxItem.NOTE && it.id == s.id }
                continue
            }
            val local = notes[s.id]
            // Replies and live updates can arrive out of order: never go backwards.
            if (local?.rev != null && s.rev != null && s.rev < local.rev) continue
            notes[s.id] = if (local != null && (s.id in pending || local.editedAt > s.editedAt)) {
                val contentDiffers = local.text != s.text || local.images != s.images
                local.copy(
                    title = s.title, summary = s.summary, aiGroup = s.aiGroup, aiPriority = s.aiPriority,
                    priorityReason = s.priorityReason, tags = s.tags, dueDate = s.dueDate, dueTime = s.dueTime,
                    aiDueDate = s.aiDueDate, aiDueTime = s.aiDueTime, role = s.role, ownerName = s.ownerName, userId = s.userId,
                    aiStatus = if (contentDiffers) "pending" else s.aiStatus, aiError = s.aiError, rev = s.rev,
                )
            } else s
        }
        _state.update { it.copy(notes = notes) }
        persistSoon()
    }

    /**
     * Sends everything waiting: photos first (each with its preview), then all
     * note changes in one request, which also returns what changed on the server.
     */
    suspend fun flush(): Unit = withContext(confined) {
        val api = api ?: return@withContext
        if (secrets.token == null) return@withContext
        if (flushing) { flushAgain = true; return@withContext }
        flushing = true
        flushAgain = false
        var sent = false
        try {
            for (item in outbox.filter { it.kind == OutboxItem.IMAGE }) {
                val thumb = storage.imageFile(item.id + ".thumb")
                if (thumb.exists()) api.putImage(item.id, withContext(Dispatchers.IO) { thumb.readBytes() }, thumb = true)
                val full = storage.imageFile(item.id)
                if (full.exists()) api.putImage(item.id, withContext(Dispatchers.IO) { full.readBytes() }, thumb = false)
                outbox = outbox.filterNot { it.kind == OutboxItem.IMAGE && it.id == item.id }
            }
            val toSend = outbox.filter { it.kind == OutboxItem.NOTE }
            val since = rev
            val res = api.sync(since, toSend.map { JsonObject((it.body ?: JsonObject(emptyMap())) + ("id" to JsonPrimitive(it.id))) })
            // Sent (or refused for good): clear each, unless a newer edit was queued meanwhile.
            val done = toSend.take(res.results.size).toSet()
            outbox = outbox.filterNot { it in done }
            merge(res.notes)
            if (since == rev && res.rev >= rev) rev = res.rev
            _state.update { it.copy(online = true) }
            sent = true
        } catch (e: ApiException) {
            handleUnauthorized(e)
            if (e.status == 0) _state.update { it.copy(online = false) }
        } finally {
            flushing = false
            persistSoon()
        }
        if (sent && flushAgain) flush()
    }

    // --------------------------------------------------------------- editing

    /**
     * Creates or updates a note. `patch` uses the server's field names
     * (text, images, done, deleted, user_group, user_priority); a null value clears it.
     */
    fun save(id: String, patch: Map<String, Any?>, send: Boolean = true) {
        scope.launch(confined) {
            val before = _state.value.notes[id]
            val t = now()
            var note = before ?: Note(id = id, createdAt = t, editedAt = t, aiStatus = "pending")
            for ((k, v) in patch) note = when (k) {
                "text" -> note.copy(text = v as String)
                "images" -> note.copy(images = (v as List<*>).map { it as String })
                "done" -> note.copy(done = v as Boolean)
                "deleted" -> note.copy(deleted = v as Boolean)
                "user_group" -> note.copy(userGroup = (v as String?)?.takeIf { it.isNotBlank() })
                "user_priority" -> note.copy(userPriority = v as String?)
                "user_due" -> note.copy(userDue = v as String?)
                "parent_id" -> note.copy(parentId = v as String?, aiStatus = "done")
                else -> note
            }
            note = note.copy(editedAt = maxOf(t, (before?.editedAt ?: 0.0) + 1))
            val changed = before == null || note.text != before.text || note.images != before.images
            if (changed && note.parentId == null) note = note.copy(aiStatus = "pending")
            _state.update { it.copy(notes = it.notes + (id to note)) }

            // One outbox entry per note: merge with an unsent change for the same note.
            val old = outbox.firstOrNull { it.kind == OutboxItem.NOTE && it.id == id }
            val body = (old?.body ?: JsonObject(mapOf("created_at" to JsonPrimitive(note.createdAt)))).toMutableMap()
            for ((k, v) in patch) body[k] = v.toJson()
            body["edited_at"] = JsonPrimitive(note.editedAt)
            outbox = outbox.filterNot { it === old } + OutboxItem(OutboxItem.NOTE, id, JsonObject(body))
            persistSoon()
            if (send) flush()
        }
    }

    /** Sends what is waiting (after several saves made with send = false, so they travel together). */
    fun sendNow() { scope.launch(confined) { flush() } }

    /**
     * A new note. Lines starting with "- ", "* ", "• ", "[ ]" or "☐" become the
     * items of a checklist; the other lines are its title and text. The list and
     * its items reach the server together, so the AI sees the items.
     */
    fun create(text: String, images: List<String>): String {
        val (rest, items) = splitList(text)
        val id = UUID.randomUUID().toString()
        save(id, mapOf("text" to (if (items.isEmpty()) text else rest), "images" to images), send = false)
        items.forEach { addItem(id, it, send = false) }
        sendNow()
        return id
    }

    /** Adds an item to a list. */
    fun addItem(listId: String, text: String, send: Boolean = true) =
        save(UUID.randomUUID().toString(), mapOf("text" to text, "parent_id" to listId), send)

    /**
     * Pasted lines: one note with a checklist (a list and its items) or
     * separate notes, each sorted by the AI on its own.
     */
    fun createMany(lines: List<String>, together: Boolean, title: String = "") {
        val clean = lines.map { it.replace(BULLET, "").trim() }.filter { it.isNotEmpty() }
        if (together) {
            val listId = UUID.randomUUID().toString()
            save(listId, mapOf("text" to title, "images" to emptyList<String>()), send = false)
            clean.forEach { addItem(listId, it, send = false) }
        } else clean.forEach { save(UUID.randomUUID().toString(), mapOf("text" to it, "images" to emptyList<String>()), send = false) }
        sendNow()
    }

    /** Marks a note done (or open again). */
    fun setDone(id: String, done: Boolean) = save(id, mapOf("done" to done))

    /** Deletes my done notes (not ones shared with me). Returns their ids, for Undo. */
    fun clearDone(ids: Collection<String>): List<String> {
        val st = _state.value
        val mine = ids.mapNotNull { st.notes[it] }.filter { it.done && !it.shared && it.parentId == null }
        mine.forEach { save(it.id, mapOf("deleted" to true), send = false) }
        sendNow()
        return mine.map { it.id }
    }

    fun undelete(ids: List<String>) {
        ids.forEach { save(it, mapOf("deleted" to false), send = false) }
        sendNow()
    }

    /** Sets the date: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM", "" for no date, or null to let the AI decide. */
    fun setDue(id: String, due: String?) = save(id, mapOf("user_due" to due))

    // --------------------------------------------------- sharing, premium, account

    suspend fun shares(): Shares = api?.shares() ?: throw ApiException.offline()
    suspend fun share(kind: String, target: String, email: String, role: String) { (api ?: throw ApiException.offline()).share(kind, target, email.trim(), role) }
    suspend fun setShareRole(id: String, role: String) { api?.setShareRole(id, role) }
    suspend fun unshare(id: String) { api?.unshare(id); flush() }
    /** Groups moved between Work and Family; empty when offline (names decide then). */
    suspend fun worlds(): Map<String, String> = runCatching { api?.worlds() }.getOrNull() ?: emptyMap()

    suspend fun plan(): Plan = api?.plan() ?: throw ApiException.offline()
    suspend fun backups(): List<Backup> = api?.backups() ?: throw ApiException.offline()
    suspend fun backupNow() { api?.backupNow() }
    suspend fun restore(id: String) { api?.restore(id); flush() }

    /** Where the person downloads all their notes (a browser link; needs the web login). */
    val exportUrl: String? get() = _state.value.serverUrl?.let { "$it/api/export" }

    /** Deletes the account on the server, then everything on this device. */
    suspend fun deleteAccount(email: String) {
        (api ?: throw ApiException.offline()).deleteAccount(email.trim())
        withContext(confined) {
            stopLiveNow()
            secrets.token = null
            setUser(null)
            wipe()
            runCatching { refreshAuthState() }
        }
    }

    /** Keeps a photo (JPEG) and its small preview on the device and queues the upload. Returns its name. */
    suspend fun addImage(full: ByteArray, thumb: ByteArray?): String = withContext(confined) {
        val name = "${UUID.randomUUID()}.jpg"
        withContext(Dispatchers.IO) {
            storage.imageFile(name).writeBytes(full)
            thumb?.let { storage.imageFile("$name.thumb").writeBytes(it) }
        }
        outbox = outbox + OutboxItem(OutboxItem.IMAGE, name)
        persistSoon()
        scope.launch(confined) { flush() }
        name
    }

    /** A photo's bytes, or its preview's: from the device, else from the server (then kept). */
    suspend fun image(name: String, thumb: Boolean): ByteArray? = withContext(Dispatchers.IO) {
        val file = storage.imageFile(if (thumb) "$name.thumb" else name)
        if (file.exists()) return@withContext file.readBytes()
        val bytes = runCatching { api?.image(name, thumb) }.getOrNull()
        if (bytes != null) { file.writeBytes(bytes); return@withContext bytes }
        if (thumb) image(name, thumb = false) else null
    }

    suspend fun reanalyze(id: String) {
        flush()
        api?.reanalyze(id)
    }

    suspend fun reorganize(): ReorganizeResult = api?.reorganize() ?: throw ApiException.offline()

    /** For tests and the background worker: wait until pending writes reach the disk. */
    suspend fun saveNow() = withContext(confined) { persistNow() }
}

private val ITEM_LINE = Regex("""^\s*(?:[-*•]|\[ ?]|☐)\s+(.+)$""")

/** Bullets and numbers at the start of pasted lines. */
private val BULLET = Regex("""^\s*(?:[-*•·–]|\d+[.)]|\[[ xX]?]|[☐☑✓✔])\s*""")

/** Splits typed text into the note's own text and its checklist items (same rules as the web app). */
fun splitList(text: String): Pair<String, List<String>> {
    val rest = mutableListOf<String>()
    val items = mutableListOf<String>()
    for (line in text.split('\n')) {
        val m = ITEM_LINE.find(line)
        if (m != null) items += m.groupValues[1].trim() else rest += line
    }
    return rest.joinToString("\n").trim() to items
}

/** Lines of pasted text without bullets; null unless there are at least two. */
fun pastedLines(text: String): List<String>? =
    text.split(Regex("\r?\n")).map { it.replace(BULLET, "").trim() }.filter { it.isNotEmpty() }.takeIf { it.size > 1 }

private fun Any?.toJson(): JsonElement = when (this) {
    null -> JsonNull
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is List<*> -> JsonArray(map { it.toJson() })
    else -> JsonPrimitive(toString())
}

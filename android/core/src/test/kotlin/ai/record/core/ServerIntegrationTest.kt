package ai.record.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Runs the Android sync code against the real record.ai server (Node.js),
 * started fresh for each test with an empty database and no AI.
 */
class ServerIntegrationTest {
    private lateinit var server: Process
    private lateinit var url: String
    private val scope = CoroutineScope(SupervisorJob())

    @BeforeTest fun startServer() {
        val root = File(System.getProperty("recordai.root") ?: "../..")
        val port = ServerSocket(0).use { it.localPort }
        url = "http://127.0.0.1:$port"
        server = ProcessBuilder("node", "--disable-warning=ExperimentalWarning", "server/index.js")
            .directory(root)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .apply {
                environment()["PORT"] = port.toString()
                environment()["DATA_DIR"] = Files.createTempDirectory("recordai-server").toString()
                environment()["AI_PROVIDER"] = "none"
                environment()["ALLOW_SIGNUP"] = "true"
            }
            .start()
        val deadline = System.currentTimeMillis() + 15_000
        while (true) {
            val up = runCatching { URI("$url/api/health").toURL().readText().contains("ok") }.getOrDefault(false)
            if (up) break
            check(System.currentTimeMillis() < deadline) { "server did not start" }
            Thread.sleep(100)
        }
    }

    @AfterTest fun stopServer() {
        server.destroy()
    }

    private fun newRepo(dir: File = Files.createTempDirectory("recordai-phone").toFile()) =
        NoteRepository(FileStorage(dir), MemorySecretStore(), scope)

    private suspend fun eventually(what: String, check: suspend () -> Boolean) {
        withTimeout(10_000) { while (!check()) delay(50) }
        assertTrue(check(), what)
    }

    @Test fun `sign up, write notes and photos, sync both ways, log out`() = runBlocking<Unit> {
        val phone = newRepo()
        phone.connect("127.0.0.1:${url.substringAfterLast(':')}")
        assertEquals(true, phone.state.value.signup?.firstAccount)
        phone.signup("Nina", "nina@example.com", "correct horse", "")
        assertEquals("Nina", phone.state.value.user?.name)

        // A note with a photo and its preview, sent in one round.
        val photo = phone.addImage(ByteArray(2000) { 1 }, ByteArray(200) { 2 })
        phone.create("Buy milk", listOf(photo))
        eventually("note reaches the server") { phone.state.value.unsent == 0 && phone.state.value.notes.values.any { it.rev != null } }

        // Another device (here: the plain API, like the web app) sees it, and the photo preview.
        val web = Api(url, Api(url, null).login("nina@example.com", "correct horse").token)
        val onServer = web.notes(0).notes.single()
        assertEquals("Buy milk", onServer.text)
        assertEquals(listOf(photo), onServer.images)
        assertEquals(200, web.image(photo, thumb = true).size)
        assertEquals(2000, web.image(photo, thumb = false).size)

        // A change made elsewhere arrives live.
        eventually("live connection is up") { phone.state.value.online }
        web.sync(0, listOf(JsonObject(mapOf(
            "id" to JsonPrimitive(onServer.id), "done" to JsonPrimitive(true), "edited_at" to JsonPrimitive(onServer.editedAt + 1),
        ))))
        eventually("live update applied") { phone.state.value.notes[onServer.id]?.done == true }

        // Choosing a group by hand, then back to automatic (null).
        phone.save(onServer.id, mapOf("user_group" to "Home", "user_priority" to "high"))
        eventually("override saved") { web.notesNow().any { it.userGroup == "Home" && it.userPriority == "high" } }
        phone.save(onServer.id, mapOf("user_group" to null, "user_priority" to null))
        eventually("override cleared") { web.notesNow().all { it.userGroup == null && it.userPriority == null } }

        // Logging out removes everything from the phone.
        phone.logout()
        assertNull(phone.state.value.user)
        assertTrue(phone.state.value.notes.isEmpty())
    }

    @Test fun `edits made offline are kept and sent later`() = runBlocking<Unit> {
        val dir = Files.createTempDirectory("recordai-offline").toFile()
        val phone = newRepo(dir)
        phone.connect(url)
        phone.signup("Nina", "nina@example.com", "correct horse", "")
        phone.stopLive()

        server.destroy()
        server.waitFor()
        phone.create("Written on the train", emptyList())
        eventually("kept in the outbox") { phone.state.value.unsent == 1 }
        phone.saveNow()

        // The app is closed and opened again: the unsent note is still there.
        val reopened = NoteRepository(FileStorage(dir), MemorySecretStore(token = "will be replaced"), scope)
        assertEquals(1, reopened.state.value.unsent)
        assertNotNull(reopened.state.value.notes.values.singleOrNull { it.text == "Written on the train" })
    }

    @Test fun `A-B tests and events work before logging in`() = runBlocking<Unit> {
        val insights = Insights(Insights.newAnonId()) { Api(url, null) }
        insights.load()
        val pitch = insights.variant("premium_pitch", "none")
        assertTrue(pitch == "backups" || pitch == "family", "got $pitch")
        insights.load()
        assertEquals(pitch, insights.variant("premium_pitch", "none"), "the same variant every time")
        insights.track("app_open", mapOf("screen" to "login"))
        insights.track("upgrade_click")
        assertEquals(2, insights.pending())
        insights.flush()
        assertEquals(0, insights.pending())
    }

    @Test fun `lists, dates, sharing, done and deleting an account`() = runBlocking<Unit> {
        val port = url.substringAfterLast(':')
        val nina = newRepo()
        nina.connect("127.0.0.1:$port")
        nina.signup("Nina", "nina@example.com", "correct horse", "")

        // A checklist typed in one go: the title line plus its items.
        val listId = nina.create("Groceries\n- milk\n- eggs", emptyList())
        eventually("list and items sent") {
            val st = nina.state.value
            st.unsent == 0 && st.notes[listId]?.rev != null && st.items(listId).size == 2 && st.items(listId).all { it.rev != null }
        }
        assertEquals("Groceries", nina.state.value.notes[listId]?.text)
        assertEquals(listOf("milk", "eggs"), nina.state.value.items(listId).map { it.text })
        assertEquals(listOf(listId), nina.state.value.visible.map { it.id }, "items aren't notes of their own")

        // Pasted lines as separate notes.
        nina.createMany(listOf("1. call school", "2. book dentist"), together = false)
        eventually("two more notes") { nina.state.value.visible.size == 3 && nina.state.value.visible.all { it.rev != null } && nina.state.value.unsent == 0 }

        // A date and time chosen by hand, then back to the AI's choice.
        nina.setDue(listId, "2026-11-03T09:30")
        eventually("date saved") { nina.state.value.notes[listId]?.let { it.due == "2026-11-03" && it.time == "09:30" } == true }
        nina.setDue(listId, null)
        eventually("date cleared") { nina.state.value.notes[listId]?.due == null }

        // Shared with Tom, who can edit: he sees it with its items, and ticks one.
        nina.share("note", listId, "tom@example.com", "edit")
        val tom = newRepo()
        tom.connect(url)
        tom.signup("Tom", "tom@example.com", "battery staple", "")
        eventually("Tom gets the shared list") { tom.state.value.items(listId).size == 2 }
        val shared = tom.state.value.notes.getValue(listId)
        assertEquals("edit", shared.role)
        assertEquals("Nina", shared.ownerName)
        assertEquals(SHARED_GROUP, shared.group)
        val milk = tom.state.value.items(listId).first { it.text == "milk" }
        tom.setDone(milk.id, true)
        eventually("Nina sees the tick live") { nina.state.value.notes[milk.id]?.done == true }

        // Clear done: only my own done notes go, and Undo brings them back.
        nina.setDone(listId, true)
        eventually("done") { tom.state.value.notes[listId]?.done == true }
        assertTrue(tom.clearDone(listOf(listId)).isEmpty(), "Tom can't delete Nina's list")
        val removed = nina.clearDone(nina.state.value.visible.map { it.id })
        assertEquals(listOf(listId), removed)
        eventually("gone for Tom too") { tom.state.value.notes[listId]?.deleted == true }
        nina.undelete(removed)
        eventually("back for Tom") { tom.state.value.notes[listId]?.deleted == false }

        // Nina stops sharing: the list leaves Tom's phone.
        val share = nina.shares().mine.single()
        assertEquals("Tom", share.name)
        nina.unshare(share.id)
        eventually("removed from Tom's phone") { tom.state.value.notes[listId] == null && tom.state.value.items(listId).isEmpty() }

        // Tom deletes his account: he is logged out and nothing stays on his phone.
        tom.deleteAccount("tom@example.com")
        assertNull(tom.state.value.user)
        assertTrue(tom.state.value.notes.isEmpty())
        val gone = runCatching { Api(url, null).login("tom@example.com", "battery staple") }
        assertTrue(gone.isFailure, "Tom's account is gone")

        // The first account owns the server and can't be deleted from a phone.
        val refused = runCatching { nina.deleteAccount("nina@example.com") }
        assertTrue(refused.isFailure)
        assertNotNull(nina.state.value.user)
        assertTrue(nina.plan().premium, "the owner has every feature")
    }

    private suspend fun Api.notesNow(): List<Note> = notes(0).notes
}

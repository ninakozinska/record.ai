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

    private suspend fun Api.notesNow(): List<Note> = notes(0).notes
}

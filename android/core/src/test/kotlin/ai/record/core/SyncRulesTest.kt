package ai.record.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SyncRulesTest {
    private fun repo() = NoteRepository(
        FileStorage(Files.createTempDirectory("recordai").toFile()),
        MemorySecretStore(),
        CoroutineScope(SupervisorJob()),
    )

    @Test fun `server addresses are normalized`() {
        assertEquals("http://172.20.10.2:3000", Api.normalize(" 172.20.10.2:3000/ "))
        assertEquals("https://mac.tail1234.ts.net", Api.normalize("https://mac.tail1234.ts.net"))
        assertNull(Api.normalize(""))
        // Typed without http(s): servers on the internet get https, computers at home http.
        assertEquals("https://record-ai-nina.fly.dev", Api.normalize("record-ai-nina.fly.dev"))
        assertEquals("http://localhost:3000", Api.normalize("localhost:3000"))
        assertEquals("http://10.0.2.2:3000", Api.normalize("10.0.2.2:3000"))
        assertEquals("http://ninas-macbook.local:3000", Api.normalize("ninas-macbook.local:3000"))
        assertEquals("http://record-ai-nina.fly.dev", Api.normalize("http://record-ai-nina.fly.dev"), "an explicit choice is kept")
    }

    @Test fun `effective group and priority prefer the person's choice`() {
        val n = Note(id = "n1", aiGroup = "Home", aiPriority = "urgent")
        assertEquals("Home", n.group)
        assertEquals(Priority.URGENT, n.priority)
        val pinned = n.copy(userGroup = "Finance", userPriority = "low")
        assertEquals("Finance", pinned.group)
        assertEquals(Priority.LOW, pinned.priority)
        assertEquals("Inbox", Note(id = "n2").group)
        assertEquals(Priority.NORMAL, Note(id = "n3").priority)
    }

    @Test fun `titles fall back to the first line, then to Photo`() {
        assertEquals("Buy milk", Note(id = "a", text = "\nBuy milk\nand eggs").displayTitle)
        assertEquals("and eggs", Note(id = "a", text = "Buy milk\nand eggs").preview)
        assertEquals("Photo", Note(id = "b", images = listOf("x.jpg")).displayTitle)
        assertEquals("AI title", Note(id = "c", text = "raw", title = "AI title").displayTitle)
    }

    @Test fun `notes sort by priority, then due date, then newest`() {
        val notes = listOf(
            Note(id = "low", aiPriority = "low", createdAt = 5.0),
            Note(id = "urgent-late", aiPriority = "urgent", dueDate = "2026-12-01"),
            Note(id = "urgent-soon", aiPriority = "urgent", dueDate = "2026-10-20"),
            Note(id = "urgent-nodate", aiPriority = "urgent", createdAt = 9.0),
            Note(id = "high", aiPriority = "high"),
        )
        assertEquals(listOf("urgent-soon", "urgent-late", "urgent-nodate", "high", "low"), notes.sortedWith(noteOrder).map { it.id })
    }

    @Test fun `older server states never overwrite newer ones`() {
        val r = repo()
        r.merge(listOf(Note(id = "n", text = "x", aiStatus = "done", rev = 10)))
        r.merge(listOf(Note(id = "n", text = "x", aiStatus = "pending", rev = 9)))
        assertEquals("done", r.state.value.notes["n"]?.aiStatus)
        r.merge(listOf(Note(id = "n", text = "x", aiStatus = "pending", rev = 11)))
        assertEquals("pending", r.state.value.notes["n"]?.aiStatus)
    }

    @Test fun `unsent edits keep their text but take fresh AI results`() = runBlocking<Unit> {
        val r = repo()
        r.merge(listOf(Note(id = "n1", text = "old", editedAt = 1.0, rev = 1)))
        r.save("n1", mapOf("text" to "new text"))
        r.saveNow()
        // The server answers with its older state plus an AI title.
        r.merge(listOf(Note(id = "n1", text = "old", editedAt = 1.0, title = "AI title", aiStatus = "done", rev = 2)))
        val n = r.state.value.notes["n1"]!!
        assertEquals("new text", n.text)
        assertEquals("AI title", n.title)
        assertEquals("pending", n.aiStatus, "text changed, so the AI must look again")
    }

    @Test fun `groups are listed biggest first`() {
        val s = UiState(notes = listOf(
            Note(id = "1", aiGroup = "Home"), Note(id = "2", aiGroup = "Work"), Note(id = "3", aiGroup = "Work"),
            Note(id = "4", aiGroup = "Old", done = true), Note(id = "5", aiGroup = "Gone", deleted = true),
        ).associateBy { it.id })
        assertEquals(listOf("Work", "Home"), s.groupNames)
    }

    @Test fun `work and family worlds follow the same rules as the web app`() {
        assertEquals(Worlds.WORK, Worlds.guess("Client projects"))
        assertEquals(Worlds.FAMILY, Worlds.guess("Groceries"))
        assertEquals(null, Worlds.guess("Ideas"))
        assertEquals(null, Worlds.guess("Work from home"))
        assertEquals(Worlds.WORK, Worlds.of("Ideas", mapOf("ideas" to "work")))
        assertEquals(null, Worlds.of("Kids", mapOf("kids" to "")))
        assertEquals(true, Worlds.shows("Ideas", Worlds.WORK, emptyMap()))
        assertEquals(false, Worlds.shows("Kids", Worlds.WORK, emptyMap()))
    }
}

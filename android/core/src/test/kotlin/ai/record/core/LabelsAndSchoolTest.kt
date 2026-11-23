package ai.record.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Labels, search and School: the same decisions as the web app (public/app.js). */
class LabelsAndSchoolTest {
    private val state = LabelsState(
        labels = listOf(Label("Leo", "blue"), Label("Bills", "red")),
        allowed = true,
        colors = listOf("indigo", "red", "orange"),
    )

    @Test fun `a new label is added once, in the next colour`() {
        assertEquals(listOf("Leo", "Bills", "Doctor"), state.adding(" Doctor ").map { it.name })
        assertEquals("orange", state.adding("Doctor").last().color)
        assertEquals(state.labels, state.adding("leo"), "the same name in another case is not added again")
        assertEquals(state.labels, state.adding("  "))
        assertEquals("indigo", LabelsState().adding("First").single().color, "no palette from the server yet")
    }

    @Test fun `label colours and editor choices`() {
        assertEquals("blue", state.colorOf("leo"))
        assertEquals("gray", state.colorOf("Old label"))
        assertEquals(listOf("Leo", "Bills", "Old label"), state.choices(listOf("Bills", "Old label")))
        assertEquals(listOf("Leo", "Bills"), Labels.toggle(listOf("Leo"), "Bills"))
        assertEquals(emptyList(), Labels.toggle(listOf("Leo"), "Leo"))
    }

    @Test fun `search finds words anywhere and label colon finds labels`() {
        val fields = listOf("Pay the swim club", "Swimming", "Family")
        assertTrue(NoteSearch.matches(fields, listOf("Leo"), ""))
        assertTrue(NoteSearch.matches(fields, listOf("Leo"), "swim club"))
        assertTrue(NoteSearch.matches(fields, listOf("Leo"), "leo"), "a label is also a word")
        assertTrue(NoteSearch.matches(fields, listOf("Leo"), "label:leo swim"))
        assertFalse(NoteSearch.matches(fields, listOf("Leo"), "label:bills"))
        assertFalse(NoteSearch.matches(fields, listOf("Leonardo"), "label:leo"), "label: needs the whole label")
        assertTrue(NoteSearch.matches(fields, listOf("School trip"), "label:school_trip"))
    }

    @Test fun `which child is asked only for unplaced school notes`() {
        val kids = listOf("Work", "School · Leo", "School · Mia")
        assertEquals(listOf("School · Leo", "School · Mia"), Worlds.childChoices("School", null, done = false, shared = false, myGroups = kids))
        assertEquals(emptyList(), Worlds.childChoices("School", "School", done = false, shared = false, myGroups = kids), "the person chose already")
        assertEquals(emptyList(), Worlds.childChoices("School", null, done = true, shared = false, myGroups = kids))
        assertEquals(emptyList(), Worlds.childChoices("School", null, done = false, shared = true, myGroups = kids))
        assertEquals(emptyList(), Worlds.childChoices("Groceries", null, done = false, shared = false, myGroups = kids))
        assertEquals(emptyList(), Worlds.childChoices("School", null, done = false, shared = false, myGroups = listOf("Work")))
        assertEquals("School · Leo", Worlds.childGroup(" Leo "))
        assertEquals("Leo", Worlds.childName("School · Leo"))
    }

    @Test fun `school groups, my groups and what a share covers`() {
        assertTrue(Worlds.inSchool("school"))
        assertTrue(Worlds.inSchool("School · Leo"))
        assertFalse(Worlds.inSchool("Schoolbooks"))
        assertEquals(Worlds.SCHOOL, Worlds.guess("School · Leo"))
        assertEquals(listOf("Home", "Work", "School · Leo"), Worlds.withMyGroups(listOf("Home", "Work"), listOf("Work", "School · Leo")))
        assertTrue(Worlds.covers("school", "School", "n1", "School · Mia"))
        assertFalse(Worlds.covers("school", "School", "n1", "Groceries"))
        assertTrue(Worlds.covers("group", "groceries", "n1", "Groceries"))
        assertTrue(Worlds.covers("note", "n1", "n1", "Anything"))
        assertFalse(Worlds.covers("note", "n2", "n1", "Anything"))
    }

    @Test fun `labels come from the person, else from the AI`() {
        val n = Note(id = "n", labels = listOf("Bills"), aiLabels = listOf("Bills"))
        assertEquals(listOf("Bills"), n.shownLabels)
        assertEquals(listOf("Leo"), n.copy(userLabels = listOf("Leo")).shownLabels)
        assertEquals(emptyList(), n.copy(userLabels = emptyList()).shownLabels, "the person took them all off")
        assertEquals(emptyList(), Note(id = "m").shownLabels)
    }
}

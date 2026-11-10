package ai.record.android.ui

import ai.record.core.HistoryDetail
import ai.record.core.HistoryEvent
import ai.record.core.Note
import ai.record.core.NoteRepository
import ai.record.core.Person
import ai.record.core.Priority
import ai.record.core.tr
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Date

/** "Created … · Edited …" and the note's history: what changed, when and by whom. */
@Composable
fun NoteHistorySection(repo: NoteRepository, note: Note, myId: String?, people: List<Person>) {
    val scope = rememberCoroutineScope()
    var open by remember(note.id) { mutableStateOf(false) }
    var events by remember(note.id) { mutableStateOf<List<HistoryEvent>?>(null) }
    var failed by remember(note.id) { mutableStateOf(false) }
    val times = buildList {
        add(tr("Created {when}").replace("{when}", whenText(note.createdAt)))
        if (note.editedAt - note.createdAt > 60_000) add(tr("Edited {when}").replace("{when}", whenText(note.editedAt)))
    }.joinToString(" · ")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(times, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = {
            open = !open
            if (open) scope.launch {
                runCatching { repo.history(note.id) }
                    .onSuccess { events = it; failed = false }
                    .onFailure { failed = true }
            }
        }) { Text(tr("🕘 History")) }
        if (open) {
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            when {
                failed -> Text(tr("The history needs a connection."), style = MaterialTheme.typography.bodySmall, color = muted)
                events == null -> Text(tr("Loading…"), style = MaterialTheme.typography.bodySmall, color = muted)
                events!!.isEmpty() -> Text(tr("No changes yet."), style = MaterialTheme.typography.bodySmall, color = muted)
                else -> events!!.forEach { e ->
                    Column {
                        Text(historyLine(e, myId, people), style = MaterialTheme.typography.bodyMedium)
                        val who = e.by?.let { " · " + if (it.id == myId) tr("you") else it.name ?: tr("someone") }.orEmpty()
                        Text(whenText(e.at) + who, style = MaterialTheme.typography.bodySmall, color = muted)
                    }
                }
            }
        }
    }
}

private fun whenText(ms: Double): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms.toLong()))

private fun day(d: HistoryDetail): String {
    val date = d.date ?: return ""
    val text = runCatching { LocalDate.parse(date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(date)
    return d.time?.let { "$text $it" } ?: text
}

private fun priority(p: String?): String = Priority.of(p)?.let { tr(it.label) } ?: p.orEmpty()

private fun historyLine(e: HistoryEvent, myId: String?, people: List<Person>): String {
    val d = e.detail ?: HistoryDetail()
    val text = d.text.orEmpty()
    fun name(id: String?) = when {
        id == null -> tr("someone")
        id == myId -> tr("you")
        else -> people.firstOrNull { it.id == id }?.name ?: tr("someone")
    }
    return when (e.kind) {
        "created" -> tr("Created")
        "edited" -> tr("Edited")
        "done" -> tr("Marked done")
        "reopened" -> tr("Opened again")
        "deleted" -> tr("Deleted")
        "restored" -> tr("Restored")
        "date" -> if (d.date == null) tr("Date removed") else tr("Date set to {date}").replace("{date}", day(d))
        "group" -> tr("Moved to {group}").replace("{group}", d.group.orEmpty())
        "priority" -> tr("Priority set to {priority}").replace("{priority}", priority(d.priority))
        "assigned" -> if (d.to == null) tr("No longer for anyone") else tr("Now for {name}").replace("{name}", name(d.to))
        "reminder" -> if (d.minutes == null) tr("Reminder removed") else tr("Reminder set")
        "sorted" -> tr("Sorted by the AI: {group}, {priority}")
            .replace("{group}", d.group ?: "Inbox")
            .replace("{priority}", priority(d.priority)) + (if (d.date != null) ", " + day(d) else "")
        "item_added" -> tr("Added \"{text}\"").replace("{text}", text)
        "item_done" -> tr("Ticked \"{text}\"").replace("{text}", text)
        "item_reopened" -> tr("Unticked \"{text}\"").replace("{text}", text)
        "item_removed" -> tr("Removed \"{text}\"").replace("{text}", text)
        "item_edited" -> tr("Changed \"{text}\"").replace("{text}", text)
        else -> e.kind
    }
}

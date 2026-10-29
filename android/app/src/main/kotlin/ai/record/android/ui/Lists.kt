package ai.record.android.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.provider.CalendarContract
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import ai.record.core.Note
import ai.record.core.NoteRepository
import ai.record.core.Share
import ai.record.core.UiState
import ai.record.core.pastedLines
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit

/** A list's items: tick them, add more, remove them. View-only lists can't be changed. */
@Composable
fun ListItems(repo: NoteRepository, state: UiState, listId: String, canEdit: Boolean) {
    var newItem by remember(listId) { mutableStateOf("") }
    var paste by remember { mutableStateOf<List<String>?>(null) }
    val items = state.items(listId)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (items.isNotEmpty()) {
            Text("☑ ${items.count { it.done }}/${items.size}", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items.forEach { item ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = item.done, enabled = canEdit, onCheckedChange = { repo.setDone(item.id, it) })
                Text(item.text, Modifier.weight(1f), textDecoration = if (item.done) TextDecoration.LineThrough else null,
                    color = if (item.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                if (canEdit) {
                    IconButton(onClick = { repo.save(item.id, mapOf("deleted" to true)) }) {
                        Icon(Icons.Filled.Close, "Remove item", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (canEdit) {
            fun add() {
                if (newItem.isNotBlank()) repo.addItem(listId, newItem.trim())
                newItem = ""
            }
            OutlinedTextField(
                value = newItem,
                onValueChange = { v ->
                    val lines = if (v.length - newItem.length > 1) pastedLines(v) else null
                    if (lines != null) paste = lines
                    else if (v.endsWith("\n")) { newItem = v.trimEnd(); add() }
                    else newItem = v
                },
                placeholder = { Text("+ Add an item") },
                singleLine = false,
                maxLines = 3,
                trailingIcon = { if (newItem.isNotBlank()) TextButton(onClick = ::add) { Text("Add") } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    paste?.let { lines ->
        PasteChoice(lines, title = "Paste ${lines.size} lines", a = "Add ${lines.size} items", b = "Add as one item") { choice ->
            paste = null
            when (choice) {
                "a" -> { lines.forEach { repo.addItem(listId, it, send = false) }; repo.sendNow() }
                "b" -> repo.addItem(listId, lines.joinToString(", "))
            }
            newItem = ""
        }
    }
}

/** The question asked when several lines are pasted. Answers "a", "b", "plain" (only when offered) or "" (closed). */
@Composable
fun PasteChoice(lines: List<String>, title: String, a: String, b: String, plain: Boolean = false, onChoice: (String) -> Unit) {
    AlertDialog(
        onDismissRequest = { onChoice("") },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f))
                IconButton(onClick = { onChoice("") }) { Icon(Icons.Filled.Close, "Close") }
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                lines.take(6).forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
                if (lines.size > 6) Text("… ${lines.size - 6} more", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { onChoice("a") }, Modifier.fillMaxWidth()) { Text(a) }
                OutlinedButton(onClick = { onChoice("b") }, Modifier.fillMaxWidth()) { Text(b) }
                if (plain) TextButton(onClick = { onChoice("plain") }, Modifier.fillMaxWidth()) { Text("Paste as text") }
            }
        },
        confirmButton = {},
    )
}

/** "📅 Today 09:30", "📅 Tue, 3 Nov", "overdue 2d"; and whether it is soon. */
fun dueText(note: Note): Pair<String, Boolean>? {
    val date = note.due?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return null
    val days = ChronoUnit.DAYS.between(LocalDate.now(), date)
    val time = note.time?.let { " $it" } ?: ""
    val sameYear = date.year == LocalDate.now().year
    return when {
        days < 0 -> "overdue ${-days}d" to true
        days == 0L -> "📅 Today$time" to true
        days == 1L -> "📅 Tomorrow$time" to true
        else -> "📅 " + date.format(DateTimeFormatter.ofPattern(if (sameYear) "EEE, d MMM" else "EEE, d MMM yyyy")) + time to (days < 7)
    }
}

/**
 * The note's date and time: pick them, remove them, or let the AI decide.
 * `due` follows user_due: null = the AI decides, "" = no date.
 */
@Composable
fun DueEditor(note: Note, due: String?, enabled: Boolean, onDue: (String?) -> Unit) {
    val context = LocalContext.current
    val shown = if (due != null) due.take(10).ifBlank { null } else note.aiDueDate ?: note.dueDate
    val shownTime = if (due != null) due.drop(11).take(5).ifBlank { null } else note.aiDueTime ?: note.dueTime
    val date = shown?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val label = date?.let { it.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) + (shownTime?.let { t -> " $t" } ?: "") }
        Text("Date: " + (label ?: "none") + if (due == null) "  (AI)" else "", style = MaterialTheme.typography.bodyMedium)
        if (!enabled) return@Column
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                val d = date ?: LocalDate.now()
                DatePickerDialog(context, { _, y, m, day ->
                    val picked = LocalDate.of(y, m + 1, day).toString()
                    onDue(picked + (shownTime?.let { "T$it" } ?: ""))
                }, d.year, d.monthValue - 1, d.dayOfMonth).show()
            }) { Text("📅 Date") }
            OutlinedButton(enabled = date != null, onClick = {
                val (h, min) = shownTime?.split(":")?.map { it.toInt() } ?: listOf(9, 0)
                TimePickerDialog(context, { _, hh, mm ->
                    onDue("${date}T%02d:%02d".format(hh, mm))
                }, h, min, true).show()
            }) { Text("🕑 Time") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = due == "", onClick = { onDue("") }, label = { Text("No date") })
            FilterChip(selected = due == null, onClick = { onDue(null) }, label = { Text("Let AI decide") })
        }
        if (date != null) {
            TextButton(onClick = {
                // The phone's own calendar app (Google Calendar, Samsung…): the person checks and saves.
                val start = shownTime?.let { LocalDateTime.parse("${date}T$it") } ?: date.atStartOfDay()
                val millis = start.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
                val intent = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, note.displayTitle)
                    .putExtra(CalendarContract.Events.DESCRIPTION, note.text)
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, millis)
                    .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, millis + if (shownTime != null) 3_600_000 else 86_400_000)
                    .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, shownTime == null)
                runCatching { context.startActivity(intent) }.onFailure { toast(context, "No calendar app found") }
            }) { Text("Add to my calendar") }
        }
    }
}

/** Share a note (with its items) or a whole group by email; see who it is shared with. */
@Composable
fun ShareDialog(repo: NoteRepository, kind: String, target: String, label: String, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var shares by remember { mutableStateOf<List<Share>>(emptyList()) }
    var email by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("edit") }
    var message by remember { mutableStateOf<String?>(null) }
    suspend fun reload() {
        runCatching { repo.shares() }.onSuccess { s ->
            shares = s.mine.filter { it.kind == kind && it.target.equals(target, ignoreCase = kind == "group") }
        }.onFailure { message = it.message }
    }
    LaunchedEffect(target) { reload() }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Share \"$label\"") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (kind == "group") "Everyone you add sees every note in this group, also ones added later."
                    else "They see this note and its items on their phone or computer.",
                    style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(email, { email = it }, label = { Text("Their email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = role == "edit", onClick = { role = "edit" }, label = { Text("Can edit") })
                    FilterChip(selected = role == "view", onClick = { role = "view" }, label = { Text("View only") })
                }
                OutlinedButton(enabled = email.contains("@"), onClick = {
                    scope.launch {
                        runCatching { repo.share(kind, target, email, role) }
                            .onSuccess { message = "Shared with ${email.trim()}"; email = ""; reload() }
                            .onFailure { message = it.message }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text("Share") }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
                shares.forEach { s ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(s.name ?: s.email.orEmpty())
                            Text((if (s.role == "view") "View only" else "Can edit") + if (s.name == null) " · invited" else "",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = {
                            scope.launch { runCatching { repo.setShareRole(s.id, if (s.role == "view") "edit" else "view") }; reload() }
                        }) { Text(if (s.role == "view") "Allow edits" else "Make view only") }
                        IconButton(onClick = { scope.launch { runCatching { repo.unshare(s.id) }; reload() } }) {
                            Icon(Icons.Filled.Close, "Stop sharing")
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Done") } },
    )
}

/** For a note shared with me: leave it (it disappears from my devices). */
suspend fun leaveShared(repo: NoteRepository, note: Note) {
    val withMe = repo.shares().withMe
    val share = withMe.firstOrNull { it.kind == "note" && it.target == note.id }
        ?: withMe.firstOrNull { s ->
            s.kind == "group" && s.owner?.id == note.userId && s.target.equals(note.userGroup ?: note.aiGroup, ignoreCase = true)
        }
    share?.let { repo.unshare(it.id) }
}

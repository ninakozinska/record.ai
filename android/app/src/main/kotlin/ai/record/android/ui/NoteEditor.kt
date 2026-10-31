package ai.record.android.ui

import ai.record.core.tr
import ai.record.core.People

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.FilterChip
import androidx.compose.foundation.horizontalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ai.record.core.NoteRepository
import ai.record.core.Priority
import ai.record.core.UiState
import kotlinx.coroutines.launch

/** Open a note: edit it, see what the AI found, choose a group or priority yourself. */
@Composable
fun NoteEditor(repo: NoteRepository, state: UiState, id: String, onClose: () -> Unit) {
    val note = state.notes[id] ?: return onClose()
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    var text by remember(id) { mutableStateOf(note.text) }
    val images = remember(id) { mutableStateListOf<String>().apply { addAll(note.images) } }
    var group by remember(id) { mutableStateOf(note.userGroup.orEmpty()) }
    var priority by remember(id) { mutableStateOf(note.userPriority) }
    var due by remember(id) { mutableStateOf(note.userDue) }
    var remind by remember(id) { mutableStateOf(note.remind) }
    var assignee by remember(id) { mutableStateOf(note.assignedTo) }
    var people by remember { mutableStateOf(People()) }
    var working by remember { mutableStateOf(false) }
    LaunchedEffect(id) { people = repo.people() }
    var sharing by remember { mutableStateOf(false) }
    val canEdit = note.canEdit
    var priorityMenu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun saveChanges() {
        val patch = mutableMapOf<String, Any?>()
        if (text != note.text) patch["text"] = text
        if (images.toList() != note.images) patch["images"] = images.toList()
        val g = group.trim().ifEmpty { null }
        if (g != note.userGroup) patch["user_group"] = g
        if (priority != note.userPriority) patch["user_priority"] = priority
        if (due != note.userDue) patch["user_due"] = due
        if (remind != note.remind) patch["remind"] = remind
        if (assignee != note.assignedTo) patch["assigned_to"] = assignee
        if (!canEdit) return
        if (note.shared) patch -= setOf("user_group", "user_priority", "user_due", "remind")
        if (patch.isNotEmpty()) repo.save(id, patch)
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row {
                    TextButton(onClick = onClose) { Text(tr("Cancel")) }
                    Box(Modifier.weight(1f))
                    if (!note.shared) TextButton(onClick = { saveChanges(); sharing = true }) { Text(tr("Share")) }
                    if (canEdit) Button(onClick = { saveChanges(); onClose() }) { Text(tr("Save")) }
                }
                Text(note.displayTitle, style = MaterialTheme.typography.titleLarge)
                if (note.shared) {
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Text("Shared by ${note.ownerName ?: "someone"}" + if (canEdit) " · you can edit" else tr(" · view only"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                        TextButton(onClick = { scope.launch { runCatching { leaveShared(repo, note) }; onClose() } }) { Text(tr("Leave")) }
                    }
                }

                val hasAi = note.summary != null || note.priorityReason != null || !note.tags.isNullOrEmpty() || note.aiStatus == "error"
                if (hasAi) {
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            note.summary?.let { Text(it) }
                            note.priorityReason?.let { Text("Priority: $it", style = MaterialTheme.typography.bodySmall) }
                            note.tags?.takeIf { it.isNotEmpty() }?.let { tags -> Text(tags.joinToString(" ") { "#$it" }, color = MaterialTheme.colorScheme.primary) }
                            if (note.aiStatus == "error") note.aiError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }

                if (canEdit) {
                    Surface(shape = MaterialTheme.shapes.medium, tonalElevation = 1.dp) {
                        NoteInputs(repo, text, { text = it }, images, { images.clear(); images.addAll(it) }, placeholder = tr("Note"), minLines = 4)
                    }
                } else {
                    if (note.text.isNotBlank()) Text(note.text)
                    note.images.forEach { NoteImage(repo, it, thumb = false, modifier = Modifier.fillMaxWidth()) }
                }

                ListItems(repo, state, id, canEdit, people.people)

                DueEditor(note, due, enabled = canEdit && !note.shared) { due = it }

                // A reminder, once the note has a date (sent as a notification by the server).
                val hasDate = (if (due != null) due.orEmpty().take(10).ifBlank { null } else note.due) != null
                if (canEdit && !note.shared && hasDate) {
                    Text(tr("Reminder"), style = MaterialTheme.typography.labelLarge)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf<Pair<Int?, String>>(null to tr("No reminder"), 0 to tr("At the time"), 15 to tr("15 minutes before"),
                            60 to tr("1 hour before"), 1440 to tr("1 day before")).forEach { (minutes, label) ->
                            FilterChip(selected = remind == minutes, onClick = { remind = minutes }, label = { Text(label) })
                        }
                    }
                }

                // Family hub: who this is for (me, or someone I share with).
                if (canEdit && people.people.size > 1) {
                    Text(tr("👤 For"), style = MaterialTheme.typography.labelLarge)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = assignee == null, onClick = { assignee = null }, label = { Text(tr("Anyone")) })
                        people.people.forEach { p ->
                            FilterChip(selected = assignee == p.id, onClick = {
                                if (p.me || people.family) assignee = p.id else error = tr("Giving tasks to others is part of the Family plan.")
                            }, label = { Text(if (p.me) tr("Me") else p.name) })
                        }
                    }
                }

                if (!note.shared) OutlinedTextField(
                    value = group,
                    onValueChange = { group = it },
                    label = { Text(tr("Group")) },
                    placeholder = { Text(tr("Auto") + (note.aiGroup?.let { " ($it)" } ?: "")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!note.shared) Box {
                    OutlinedButton(onClick = { priorityMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        val auto = Priority.of(note.aiPriority)?.let { "Auto (${it.label})" } ?: tr("Auto")
                        Text(tr("Priority: ") + (Priority.of(priority)?.label ?: auto))
                    }
                    DropdownMenu(expanded = priorityMenu, onDismissRequest = { priorityMenu = false }) {
                        DropdownMenuItem(text = { Text(tr("Auto")) }, onClick = { priority = null; priorityMenu = false })
                        Priority.entries.forEach { p ->
                            DropdownMenuItem(text = { Text(p.label, color = p.color, fontWeight = FontWeight.SemiBold) }, onClick = { priority = p.key; priorityMenu = false })
                        }
                    }
                }
                if (!note.shared) Text(tr("Leave these on Auto to let the AI decide. Your choice is kept."), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)

                if (canEdit) OutlinedButton(onClick = {
                    saveChanges()
                    repo.save(id, mapOf("done" to !note.done))
                    onClose()
                }, modifier = Modifier.fillMaxWidth()) { Text(if (note.done) tr("Mark not done") else tr("✓ Mark done")) }
                // A letter, an invitation or a photo of one: each thing to do becomes a note with its date.
                if (!note.shared && (note.images.isNotEmpty() || note.text.length > 60)) OutlinedButton(enabled = !working, onClick = {
                    saveChanges()
                    working = true
                    scope.launch {
                        runCatching { repo.extractTasks(id) }
                            .onSuccess { n -> toast(context, if (n == 0) tr("Nothing to do in this one.") else "✓ $n"); onClose() }
                            .onFailure { error = it.message }
                        working = false
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text(tr("📸 Turn into tasks")) }
                if (!note.shared) OutlinedButton(onClick = {
                    saveChanges()
                    scope.launch {
                        runCatching { repo.reanalyze(id) }.onSuccess { onClose() }.onFailure { error = it.message }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text(tr("Re-analyze with AI")) }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (!note.shared) TextButton(onClick = { confirmDelete = true }) { Text(tr("Delete note"), color = MaterialTheme.colorScheme.error) }
            }
        }
    }

    if (sharing) ShareDialog(repo, "note", id, note.displayTitle, onClose = { sharing = false })

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(tr("Delete this note?")) },
            confirmButton = {
                TextButton(onClick = { repo.save(id, mapOf("deleted" to true)); confirmDelete = false; onClose() }) {
                    Text(tr("Delete"), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(tr("Cancel")) } },
        )
    }
}

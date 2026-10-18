package ai.record.android.ui

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
    var text by remember(id) { mutableStateOf(note.text) }
    val images = remember(id) { mutableStateListOf<String>().apply { addAll(note.images) } }
    var group by remember(id) { mutableStateOf(note.userGroup.orEmpty()) }
    var priority by remember(id) { mutableStateOf(note.userPriority) }
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
        if (patch.isNotEmpty()) repo.save(id, patch)
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(
                Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row {
                    TextButton(onClick = onClose) { Text("Cancel") }
                    Box(Modifier.weight(1f))
                    Button(onClick = { saveChanges(); onClose() }) { Text("Save") }
                }
                Text(note.displayTitle, style = MaterialTheme.typography.titleLarge)

                val hasAi = note.summary != null || note.priorityReason != null || note.dueDate != null || !note.tags.isNullOrEmpty() || note.aiStatus == "error"
                if (hasAi) {
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            note.summary?.let { Text(it) }
                            note.priorityReason?.let { Text("Priority: $it", style = MaterialTheme.typography.bodySmall) }
                            note.dueDate?.let { Text("Due $it", style = MaterialTheme.typography.bodySmall) }
                            note.tags?.takeIf { it.isNotEmpty() }?.let { tags -> Text(tags.joinToString(" ") { "#$it" }, color = MaterialTheme.colorScheme.primary) }
                            if (note.aiStatus == "error") note.aiError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }

                Surface(shape = MaterialTheme.shapes.medium, tonalElevation = 1.dp) {
                    NoteInputs(repo, text, { text = it }, images, { images.clear(); images.addAll(it) }, placeholder = "Note", minLines = 4)
                }

                OutlinedTextField(
                    value = group,
                    onValueChange = { group = it },
                    label = { Text("Group") },
                    placeholder = { Text("Auto" + (note.aiGroup?.let { " ($it)" } ?: "")) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Box {
                    OutlinedButton(onClick = { priorityMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        val auto = Priority.of(note.aiPriority)?.let { "Auto (${it.label})" } ?: "Auto"
                        Text("Priority: " + (Priority.of(priority)?.label ?: auto))
                    }
                    DropdownMenu(expanded = priorityMenu, onDismissRequest = { priorityMenu = false }) {
                        DropdownMenuItem(text = { Text("Auto") }, onClick = { priority = null; priorityMenu = false })
                        Priority.entries.forEach { p ->
                            DropdownMenuItem(text = { Text(p.label, color = p.color, fontWeight = FontWeight.SemiBold) }, onClick = { priority = p.key; priorityMenu = false })
                        }
                    }
                }
                Text("Leave these on Auto to let the AI decide. Your choice is kept.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)

                OutlinedButton(onClick = {
                    saveChanges()
                    repo.save(id, mapOf("done" to !note.done))
                    onClose()
                }, modifier = Modifier.fillMaxWidth()) { Text(if (note.done) "Mark not done" else "Mark done") }
                OutlinedButton(onClick = {
                    saveChanges()
                    scope.launch {
                        runCatching { repo.reanalyze(id) }.onSuccess { onClose() }.onFailure { error = it.message }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text("Re-analyze with AI") }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = { confirmDelete = true }) { Text("Delete note", color = MaterialTheme.colorScheme.error) }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this note?") },
            confirmButton = {
                TextButton(onClick = { repo.save(id, mapOf("deleted" to true)); confirmDelete = false; onClose() }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

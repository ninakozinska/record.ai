package ai.record.android.ui

import ai.record.core.tr

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.record.core.Labels
import ai.record.core.Note
import ai.record.core.NoteRepository
import ai.record.core.Suggestion
import ai.record.core.UiState
import ai.record.core.Worlds
import kotlinx.coroutines.launch

/** A label as a chip: "🏷 Leo" in its colour; `off` when it is a choice not on the note. */
@Composable
fun LabelChip(state: UiState, name: String, selected: Boolean, onClick: () -> Unit) {
    val color = Color(Labels.argb(state.labels.colorOf(name)))
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text("🏷 $name", color = if (selected) color else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold) },
        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = color.copy(alpha = 0.14f)),
    )
}

/** Asks for a name (a group, a child, a label). Empty or Cancel does nothing. */
@Composable
fun NameDialog(title: String, label: String, onClose: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = { OutlinedTextField(name, { name = it }, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { onClose(); onDone(name.trim()) }) { Text(tr("Add")) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(tr("Cancel")) } },
    )
}

/** "🎒 Which child?" under a school note the AI could not place: one tap moves it. */
@Composable
fun WhichChild(repo: NoteRepository, state: UiState, note: Note) {
    val kids = Worlds.childChoices(note.group, note.userGroup, note.done, note.shared, state.myGroups)
    if (kids.isEmpty()) return
    val context = LocalContext.current
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(tr("🎒 Which child?"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        kids.forEach { g ->
            FilterChip(selected = false, onClick = {
                repo.save(note.id, mapOf("user_group" to g))
                toast(context, tr("Moved to {child}.").replace("{child}", Worlds.childName(g)))
            }, label = { Text(Worlds.childName(g)) })
        }
        FilterChip(selected = false, onClick = {
            repo.save(note.id, mapOf("user_group" to "School"))
            toast(context, tr("Kept in School, for all children."))
        }, label = { Text(tr("All children")) })
    }
}

/** The world a group is in, as people read it. */
fun worldLabel(world: String?): String = when (world) {
    Worlds.WORK -> tr("💼 Work")
    Worlds.FAMILY -> tr("🏡 Family")
    Worlds.SCHOOL -> tr("🎒 School")
    else -> tr("All worlds")
}

/** Moves a group to another world, on every device, and says so. */
suspend fun moveToWorld(repo: NoteRepository, context: android.content.Context, group: String, world: String) {
    runCatching { repo.setWorld(group, world) }
        .onSuccess { toast(context, tr("\"{group}\" is now in {world}").replace("{group}", group).replace("{world}", worldLabel(world.ifEmpty { null }))) }
        .onFailure { toast(context, it.message ?: tr("You need to be online for this.")) }
}

/** Suggested to-dos: the AI proposes, the person adds or dismisses each one. */
@Composable
fun SuggestionsDialog(repo: NoteRepository, state: UiState, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var editing by remember { mutableStateOf<Suggestion?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun decide(s: Suggestion, add: Boolean, title: String? = null) {
        scope.launch {
            runCatching { repo.decideSuggestion(s.id, add, title) }
                .onSuccess { if (add) toast(context, tr("Added to your notes")) }
                .onFailure { toast(context, it.message ?: tr("You need to be online for this.")) }
        }
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(tr("✨ Suggested")) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(tr("To-dos the AI found in your meetings, notes and AI chats. Nothing is added until you add it."),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.suggestions.isEmpty()) Text(tr("Nothing to review right now."), color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.suggestions.forEach { s ->
                    HorizontalDivider()
                    Text((if (s.top) "⭐ " else "") + s.title, fontWeight = FontWeight.SemiBold)
                    val due = s.dueDate?.let { "📅 $it" + (s.dueTime?.let { t -> " · $t" } ?: "") }
                    val from = tr("From:") + " " + (s.sourceLabel ?: tr("your notes")) + (s.reason?.let { " · $it" } ?: "")
                    Text(listOfNotNull(due, from).joinToString("  "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = { decide(s, add = true) }) { Text(tr("Add")) }
                        TextButton(onClick = { editing = s }) { Text(tr("Edit and add")) }
                        TextButton(onClick = { decide(s, add = false) }) { Text(tr("Dismiss")) }
                    }
                }
                HorizontalDivider()
                OutlinedButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        runCatching { repo.suggestNow() }.onFailure { toast(context, it.message ?: tr("You need to be online for this.")) }
                        busy = false
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text(tr("✨ Suggest now")) }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(tr("Done")) } },
    )
    editing?.let { s ->
        var title by remember(s.id) { mutableStateOf(s.title) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(tr("Edit the to-do")) },
            text = { OutlinedTextField(title, { title = it }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = {
                TextButton(enabled = title.isNotBlank(), onClick = { editing = null; decide(s, add = true, title = title.trim()) }) { Text(tr("Add")) }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text(tr("Cancel")) } },
        )
    }
}

/** "Send feedback": a few words to the people who make SortMemo. */
@Composable
fun FeedbackDialog(repo: NoteRepository, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(tr("💬 Send feedback")) },
        text = {
            OutlinedTextField(text, { text = it }, minLines = 4, placeholder = { Text(tr("What would make SortMemo better for you? Anything goes: ideas, problems, wishes.")) },
                modifier = Modifier.fillMaxWidth())
        },
        confirmButton = {
            TextButton(enabled = text.isNotBlank(), onClick = {
                scope.launch {
                    runCatching { repo.feedback(text) }
                        .onSuccess { toast(context, tr("Thank you! Nina reads every message.")); onClose() }
                        .onFailure { toast(context, it.message ?: tr("You need to be online for this.")) }
                }
            }) { Text(tr("Send")) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(tr("Cancel")) } },
    )
}

/** Privacy, terms and help on the SortMemo website (they open in the browser). */
@Composable
fun LegalLinks(serverUrl: String?) {
    val context = LocalContext.current
    val base = (serverUrl ?: ai.record.core.Api.DEFAULT_SERVER).trimEnd('/')
    fun open(page: String) {
        runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("$base/legal/$page"))) }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { open("privacy.html") }) { Text(tr("Privacy")) }
        TextButton(onClick = { open("terms.html") }) { Text(tr("Terms")) }
        TextButton(onClick = { open("support.html") }) { Text(tr("Help")) }
    }
}

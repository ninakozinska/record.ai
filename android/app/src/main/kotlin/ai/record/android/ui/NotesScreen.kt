@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package ai.record.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.record.core.Note
import ai.record.core.NoteRepository
import ai.record.core.Priority
import ai.record.core.UiState
import ai.record.core.noteOrder
import ai.record.core.pastedLines
import kotlinx.coroutines.launch

private data class Section(val title: String, val color: Color?, val notes: List<Note>)

/** The main screen: notes by priority or group, and a box to write a new note. */
@Composable
fun NotesScreen(repo: NoteRepository, state: UiState, sharedText: String?, onSharedUsed: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var byGroup by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var group by rememberSaveable { mutableStateOf<String?>(null) }
    var showDone by rememberSaveable { mutableStateOf(false) }
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var account by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    var paste by remember { mutableStateOf<Pair<String, List<String>>?>(null) }
    val snackbar = remember { SnackbarHostState() }

    /** A short message at the bottom; `undo` runs if they tap Undo. */
    fun notify(text: String, undo: (() -> Unit)? = null) {
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            val r = snackbar.showSnackbar(text, actionLabel = if (undo != null) "Undo" else null, duration = SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) undo?.invoke()
        }
    }

    /** Typing goes straight in; several pasted lines ask how to add them. */
    fun onDraft(v: String) {
        val prefix = v.commonPrefixWith(draft).length
        val suffix = minOf(v.length - prefix, draft.length - prefix).let { max ->
            v.reversed().commonPrefixWith(draft.reversed()).length.coerceAtMost(max)
        }
        val inserted = v.substring(prefix, v.length - suffix)
        val lines = if (inserted.length > 1) pastedLines(inserted) else null
        if (lines != null) paste = v to lines else draft = v
    }

    // New-note box.
    var draft by rememberSaveable { mutableStateOf("") }
    val draftImages = remember { mutableStateListOf<String>() }
    LaunchedEffect(sharedText) {
        if (sharedText != null) { onDraft(draft + sharedText); onSharedUsed() }
    }

    val words = query.lowercase().split(" ").filter { it.isNotBlank() }
    val filtered = state.visible.filter { n ->
        (group == null || n.group == group) && (words.isEmpty() || words.all { w ->
            listOf(n.text, n.title.orEmpty(), n.summary.orEmpty(), n.group, n.tags.orEmpty().joinToString(" ")).joinToString(" ").lowercase().contains(w)
        })
    }
    val open = filtered.filter { !it.done }.sortedWith(noteOrder)
    val done = filtered.filter { it.done }.sortedByDescending { it.editedAt }
    val sections = if (byGroup) {
        state.groupNames.mapNotNull { g -> open.filter { it.group == g }.takeIf { it.isNotEmpty() }?.let { Section(g, null, it) } }
    } else {
        Priority.entries.mapNotNull { p -> open.filter { it.priority == p }.takeIf { it.isNotEmpty() }?.let { Section(p.label, p.color, it) } }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(9.dp).background(if (!state.online) Color(0xFFDC2626) else if (state.unsent > 0) Color(0xFFEA7A0C) else Color(0xFF16A34A), CircleShape))
                        Spacer(Modifier.width(10.dp))
                        Text("record.ai")
                    }
                },
                actions = {
                    IconButton(onClick = { searching = !searching; if (!searching) query = "" }) { Icon(Icons.Filled.Search, "Search") }
                    Box {
                        Surface(
                            onClick = { menu = true },
                            shape = CircleShape,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(end = 12.dp).size(32.dp),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Text(state.user?.initials ?: "?", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold)
                            }
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (state.aiEnabled) {
                                DropdownMenuItem(text = { Text("Reorganize with AI") }, onClick = {
                                    menu = false
                                    scope.launch {
                                        toast(context, "Reorganizing…")
                                        runCatching { repo.reorganize() }
                                            .onSuccess { toast(context, if (it.skipped == true) "Already reorganizing" else "Reorganized: ${it.updated ?: 0} note(s) moved") }
                                            .onFailure { toast(context, it.message ?: "Could not reorganize") }
                                    }
                                })
                            }
                            DropdownMenuItem(text = { Text("Account") }, onClick = { menu = false; account = true })
                        }
                    }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp, modifier = Modifier.imePadding()) {
                Row(Modifier.navigationBarsPadding().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                    Box(Modifier.weight(1f)) {
                        NoteInputs(repo, draft, ::onDraft, draftImages, { draftImages.clear(); draftImages.addAll(it) })
                    }
                    val empty = draft.isBlank() && draftImages.isEmpty()
                    IconButton(enabled = !empty, onClick = {
                        repo.create(draft.trim(), draftImages.toList())
                        draft = ""
                        draftImages.clear()
                    }) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Save note", tint = if (empty) Color.Gray else MaterialTheme.colorScheme.primary) }
                }
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + 16.dp)) {
            item(key = "controls") {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (searching) {
                        OutlinedTextField(query, { query = it }, placeholder = { Text("Search notes") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    }
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        SegmentedButton(selected = !byGroup, onClick = { byGroup = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("Priority") }
                        SegmentedButton(selected = byGroup, onClick = { byGroup = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Groups") }
                    }
                    if (state.groupNames.isNotEmpty()) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(selected = group == null, onClick = { group = null }, label = { Text("All") })
                            state.groupNames.forEach { g -> FilterChip(selected = group == g, onClick = { group = g }, label = { Text(g) }) }
                        }
                    }
                    if (!state.aiEnabled) {
                        Text("AI sorting is off on your server. Notes are saved and synced but not sorted.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            sections.forEach { section ->
                stickyHeader(key = "h-" + section.title) {
                    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
                        Text("${section.title.uppercase()}  ${section.notes.size}",
                            style = MaterialTheme.typography.labelLarge,
                            color = section.color ?: MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                    }
                }
                items(section.notes, key = { it.id }) { note ->
                    NoteRow(repo, state, note, showGroup = !byGroup, onOpen = { editing = note.id }, onDone = {
                        repo.setDone(note.id, true)
                        notify("Marked done") { repo.setDone(note.id, false) }
                    })
                }
            }
            if (open.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (state.visible.isEmpty()) "No notes yet. Type, dictate or take a photo below. AI will title, prioritize and group them for you."
                        else "Nothing here.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(32.dp),
                    )
                }
            }
            if (done.isNotEmpty()) {
                item(key = "done-toggle") {
                    Row(Modifier.padding(horizontal = 8.dp)) {
                        TextButton(onClick = { showDone = !showDone }) {
                            Text(if (showDone) "Hide done (${done.size})" else "Show done (${done.size})")
                        }
                        if (showDone && done.any { !it.shared }) TextButton(onClick = { confirmClear = true }) {
                            Text("Clear done", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                if (showDone) items(done, key = { "d-" + it.id }) { note ->
                    NoteRow(repo, state, note, showGroup = true, onOpen = { editing = note.id }, onDone = {
                        repo.setDone(note.id, false)
                        notify("Back to open notes") { repo.setDone(note.id, true) }
                    })
                }
            }
        }
    }

    editing?.let { id -> NoteEditor(repo, state, id, onClose = { editing = null }) }
    if (account) AccountDialog(repo, state, onClose = { account = false })

    if (confirmClear) {
        val mine = done.filter { !it.shared }
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Delete ${mine.size} done note${if (mine.size == 1) "" else "s"}?") },
            text = { Text("You can undo this for a few seconds.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    val removed = repo.clearDone(mine.map { it.id })
                    notify("${removed.size} done note${if (removed.size == 1) "" else "s"} deleted") { repo.undelete(removed) }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }

    paste?.let { (full, lines) ->
        val n = lines.size
        PasteChoice(lines, title = "Paste $n lines", a = "One note with a checklist ($n items)", b = "$n separate notes", plain = true) { choice ->
            paste = null
            when (choice) {
                "a" -> {
                    // The text typed so far stays (it becomes the title); each line becomes an item.
                    val kept = draft.trimEnd()
                    draft = (if (kept.isEmpty()) "" else kept + "\n") + lines.joinToString("\n") { "- $it" }
                }
                "b" -> { repo.createMany(lines, together = false); notify("$n notes added") }
                "plain" -> draft = full
            }
        }
    }
}

/** One note in the list. */
@Composable
private fun NoteRow(repo: NoteRepository, state: UiState, note: Note, showGroup: Boolean, onOpen: () -> Unit, onDone: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).alpha(if (note.done) 0.6f else 1f).padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Box(Modifier.width(3.dp).height(48.dp).background(note.priority.color, RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(note.displayTitle, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (note.done) TextDecoration.LineThrough else null, modifier = Modifier.weight(1f, fill = false))
                when (note.aiStatus) {
                    "pending" -> Icon(Icons.Filled.AutoAwesome, "AI is organizing this note", Modifier.padding(start = 6.dp).size(14.dp), tint = MaterialTheme.colorScheme.primary)
                    "error" -> Icon(Icons.Filled.Warning, "AI could not process this note", Modifier.padding(start = 6.dp).size(14.dp), tint = Color(0xFFEAB308))
                }
            }
            if (note.preview.isNotBlank()) {
                Text(note.preview, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            val items = state.items(note.id)
            if (items.isNotEmpty()) {
                val open = items.filter { !it.done }
                Text("☑ ${items.size - open.size}/${items.size}", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                open.take(4).forEach { item ->
                    Text("☐ " + item.text, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (open.size > 4) Text("+ ${open.size - 4} more", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (note.images.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    note.images.forEach { NoteImage(repo, it, thumb = true, modifier = Modifier.size(84.dp).clip(RoundedCornerShape(8.dp))) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(note.priority.label + if (note.userPriority != null) " (pinned)" else "",
                    style = MaterialTheme.typography.labelMedium, color = note.priority.color, fontWeight = FontWeight.SemiBold)
                if (note.shared) {
                    Text("Shared by ${note.ownerName ?: "someone"}" + if (note.canEdit) "" else " · view only",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                } else if (showGroup) Text(note.group, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                dueText(note)?.let { (label, soon) ->
                    Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                        color = if (soon) Color(0xFFDC2626) else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.weight(1f))
                if (note.canEdit) TextButton(onClick = onDone, contentPadding = PaddingValues(horizontal = 10.dp)) {
                    Text(if (note.done) "↺ Reopen" else "✓ Done", style = MaterialTheme.typography.labelLarge)
                }
            }
            HorizontalDivider(Modifier.padding(top = 6.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        }
    }
}

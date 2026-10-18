package ai.record.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.record.core.NoteRepository

/** Chooses the screen: connect to a server, log in, or the notes. */
@Composable
fun AppRoot(repo: NoteRepository, sharedText: String?, onSharedUsed: () -> Unit) {
    val state by repo.state.collectAsStateWithLifecycle()
    when {
        state.serverUrl == null -> ConnectScreen(repo)
        !state.loggedIn -> LoginScreen(repo, state)
        else -> NotesScreen(repo, state, sharedText, onSharedUsed)
    }
}

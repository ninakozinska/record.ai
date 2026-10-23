package ai.record.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ai.record.core.AccountInfo
import ai.record.core.NoteRepository
import ai.record.core.UiState
import kotlinx.coroutines.launch

/** Name and email, change password, log out. */
@Composable
fun AccountDialog(repo: NoteRepository, state: UiState, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var confirmLogout by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf<AccountInfo?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(reload) { info = runCatching { repo.accountInfo() }.getOrNull() }
    // Accounts made with Google etc. have no password until they set one.
    val hasPassword = info?.hasPassword ?: true

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(state.user?.name ?: "Account") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(state.user?.email.orEmpty())
                state.serverUrl?.let { Text("Server: $it", style = MaterialTheme.typography.bodySmall) }
                info?.identities?.takeIf { it.isNotEmpty() }?.let { identities ->
                    HorizontalDivider()
                    Text("Sign-in options", style = MaterialTheme.typography.titleSmall)
                    identities.forEach { identity ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(identity.name)
                                identity.email?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                            }
                            TextButton(onClick = {
                                scope.launch {
                                    runCatching { repo.disconnect(identity.provider) }
                                        .onSuccess { reload++ }
                                        .onFailure { message = (it.message ?: "Could not disconnect.") to true }
                                }
                            }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                    Text("To connect more, open record.ai in a browser and tap your initials.", style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
                Text(if (hasPassword) "Change password" else "Set a password", style = MaterialTheme.typography.titleSmall)
                if (hasPassword) {
                    OutlinedTextField(current, { current = it }, label = { Text("Current password") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(next, { next = it }, label = { Text("New password (at least 8 characters)") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedButton(enabled = (!hasPassword || current.isNotEmpty()) && next.isNotEmpty(), onClick = {
                    scope.launch {
                        runCatching { repo.changePassword(current, next) }
                            .onSuccess { current = ""; next = ""; reload++; message = "Password saved. Your other devices must log in again." to false }
                            .onFailure { message = (it.message ?: "Could not change the password.") to true }
                    }
                }) { Text(if (hasPassword) "Change password" else "Set password") }
                message?.let { (text, isError) -> Text(text, color = if (isError) MaterialTheme.colorScheme.error else Color(0xFF16A34A)) }
                HorizontalDivider()
                TextButton(onClick = {
                    scope.launch {
                        runCatching { repo.logoutOtherDevices() }
                            .onSuccess { message = "Other devices are logged out." to false }
                            .onFailure { message = (it.message ?: "Could not log out other devices.") to true }
                    }
                }) { Text("Log out other devices") }
                TextButton(onClick = { confirmLogout = true }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
                Text("Logging out removes your notes from this phone. They stay safe on your server.", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Done") } },
    )

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Log out?") },
            text = {
                Text(if (state.unsent > 0) "${state.unsent} change(s) haven't reached the server yet and will be lost." else "Log out of record.ai on this phone?")
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        repo.flush()
                        repo.logout()
                        confirmLogout = false
                        onClose()
                    }
                }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Cancel") } },
        )
    }
}

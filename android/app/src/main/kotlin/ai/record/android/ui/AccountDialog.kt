package ai.record.android.ui

import ai.record.core.tr

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
import ai.record.core.Backup
import ai.record.core.Plan
import java.text.DateFormat
import java.util.Date
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
    var plan by remember { mutableStateOf<Plan?>(null) }
    var backups by remember { mutableStateOf<List<Backup>>(emptyList()) }
    var restoring by remember { mutableStateOf<Backup?>(null) }
    var deleting by remember { mutableStateOf(false) }
    LaunchedEffect(reload) {
        info = runCatching { repo.accountInfo() }.getOrNull()
        plan = runCatching { repo.plan() }.getOrNull()
        if (plan?.premium == true) backups = runCatching { repo.backups() }.getOrDefault(emptyList())
    }
    // Accounts made with Google etc. have no password until they set one.
    val hasPassword = info?.hasPassword ?: true

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(state.user?.name ?: tr("Account")) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(state.user?.email.orEmpty())
                state.serverUrl?.let { Text("Server: $it", style = MaterialTheme.typography.bodySmall) }
                info?.identities?.takeIf { it.isNotEmpty() }?.let { identities ->
                    HorizontalDivider()
                    Text(tr("Sign-in options"), style = MaterialTheme.typography.titleSmall)
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
                                        .onFailure { message = (it.message ?: tr("Could not disconnect.")) to true }
                                }
                            }) { Text(tr("Disconnect"), color = MaterialTheme.colorScheme.error) }
                        }
                    }
                    Text(tr("To connect more, open record.ai in a browser and tap your initials."), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
                Text(if (hasPassword) tr("Change password") else tr("Set a password"), style = MaterialTheme.typography.titleSmall)
                if (hasPassword) {
                    OutlinedTextField(current, { current = it }, label = { Text(tr("Current password")) }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(next, { next = it }, label = { Text(tr("New password (at least 8 characters)")) }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedButton(enabled = (!hasPassword || current.isNotEmpty()) && next.isNotEmpty(), onClick = {
                    scope.launch {
                        runCatching { repo.changePassword(current, next) }
                            .onSuccess { current = ""; next = ""; reload++; message = tr("Password saved. Your other devices must log in again.") to false }
                            .onFailure { message = (it.message ?: tr("Could not change the password.")) to true }
                    }
                }) { Text(if (hasPassword) tr("Change password") else tr("Set password")) }
                message?.let { (text, isError) -> Text(text, color = if (isError) MaterialTheme.colorScheme.error else Color(0xFF16A34A)) }
                HorizontalDivider()
                TextButton(onClick = {
                    scope.launch {
                        runCatching { repo.logoutOtherDevices() }
                            .onSuccess { message = tr("Other devices are logged out.") to false }
                            .onFailure { message = (it.message ?: tr("Could not log out other devices.")) to true }
                    }
                }) { Text(tr("Log out other devices")) }
                TextButton(onClick = { confirmLogout = true }) { Text(tr("Log out"), color = MaterialTheme.colorScheme.error) }
                Text(tr("Logging out removes your notes from this phone. They stay safe on your server."), style = MaterialTheme.typography.bodySmall)
                plan?.let { VoicePicker(it.canReadAloud) }
                plan?.let { p ->
                    HorizontalDivider()
                    Text(tr("Premium"), style = MaterialTheme.typography.titleSmall)
                    if (!p.premium) {
                        Text(tr("Daily backups kept 30 days, and restoring them, are part of Premium."), style = MaterialTheme.typography.bodySmall)
                    } else {
                        Text(tr("A backup of your notes is made every day and kept 30 days."), style = MaterialTheme.typography.bodySmall)
                        OutlinedButton(onClick = {
                            scope.launch {
                                runCatching { repo.backupNow() }
                                    .onSuccess { message = tr("Backup made.") to false; reload++ }
                                    .onFailure { message = (it.message ?: tr("Could not make a backup.")) to true }
                            }
                        }) { Text(tr("Back up now")) }
                        backups.take(10).forEach { b ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(b.createdAt.toLong())))
                                    Text("${b.notes} notes" + when (b.kind) { "manual" -> " · by hand"; "before-restore" -> " · before a restore"; else -> "" },
                                        style = MaterialTheme.typography.bodySmall)
                                }
                                TextButton(onClick = { restoring = b }) { Text(tr("Restore")) }
                            }
                        }
                    }
                }
                HorizontalDivider()
                TextButton(onClick = { deleting = true }) { Text(tr("Delete my account"), color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(tr("Done")) } },
    )

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text(tr("Log out?")) },
            text = {
                Text(if (state.unsent > 0) "${state.unsent} change(s) haven't reached the server yet and will be lost." else tr("Log out of record.ai on this phone?"))
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        repo.flush()
                        repo.logout()
                        confirmLogout = false
                        onClose()
                    }
                }) { Text(tr("Log out"), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text(tr("Cancel")) } },
        )
    }

    restoring?.let { b ->
        AlertDialog(
            onDismissRequest = { restoring = null },
            title = { Text(tr("Restore this backup?")) },
            text = { Text(tr("Your notes go back to how they were then. Notes written since are deleted. A backup of how they are now is made first, so you can undo this.")) },
            confirmButton = {
                TextButton(onClick = {
                    restoring = null
                    scope.launch {
                        runCatching { repo.restore(b.id) }
                            .onSuccess { message = tr("Restored.") to false; reload++ }
                            .onFailure { message = (it.message ?: tr("Could not restore.")) to true }
                    }
                }) { Text(tr("Restore")) }
            },
            dismissButton = { TextButton(onClick = { restoring = null }) { Text(tr("Cancel")) } },
        )
    }

    if (deleting) {
        var email by remember { mutableStateOf("") }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text(tr("Delete your account?")) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(tr("This deletes your account, all your notes and photos, and your backups, for good. People you shared with lose access to them."))
                    OutlinedTextField(email, { email = it }, label = { Text(tr("Type your email to confirm")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = email.trim().equals(state.user?.email, ignoreCase = true), onClick = {
                    scope.launch {
                        runCatching { repo.deleteAccount(email) }
                            .onSuccess { deleting = false; onClose() }
                            .onFailure { error = it.message }
                    }
                }) { Text(tr("Delete for good"), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text(tr("Cancel")) } },
        )
    }
}

package ai.record.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ai.record.core.NoteRepository
import ai.record.core.UiState
import kotlinx.coroutines.launch

/** Log in, or create an account. */
@Composable
fun LoginScreen(repo: NoteRepository, state: UiState) {
    val policy = state.signup
    var signingUp by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        runCatching { repo.refreshAuthState() }
    }
    LaunchedEffect(policy?.firstAccount) { if (policy?.firstAccount == true) signingUp = true }

    val title = when {
        signingUp && policy?.firstAccount == true -> "Create your account"
        signingUp -> "Create an account"
        else -> "Log in"
    }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(
            when {
                signingUp && policy?.firstAccount == true -> "This is the first account on your server. It will own all notes already saved there."
                signingUp -> "Your notes are private to your account."
                else -> "Log in with the same email and password as on your computer."
            },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (signingUp) {
            OutlinedTextField(name, { name = it }, label = { Text("Your name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words))
        }
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        if (signingUp && policy?.needsCode == true) {
            OutlinedTextField(code, { code = it }, label = { Text("Invite code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    runCatching {
                        if (signingUp) repo.signup(name, email, password, code) else repo.login(email, password)
                    }.onFailure { error = it.message }
                    busy = false
                }
            },
            enabled = !busy && email.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (signingUp) "Create account" else "Log in") }
        if (policy == null || (policy.open && !policy.firstAccount)) {
            TextButton(onClick = { signingUp = !signingUp; error = null }) {
                Text(if (signingUp) "I already have an account" else "Create an account")
            }
        }
        TextButton(onClick = { scope.launch { repo.forgetServer() } }) {
            Text("Use a different server", color = MaterialTheme.colorScheme.error)
        }
        state.serverUrl?.let { Text("Connected to $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

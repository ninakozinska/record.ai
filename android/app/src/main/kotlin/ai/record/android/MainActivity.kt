package ai.record.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import ai.record.android.ui.AppRoot
import ai.record.android.ui.RecordAiTheme
import ai.record.android.ui.hearToday
import kotlinx.coroutines.launch

/** A "Continue with …" sign-in finishing in the background; the login screen shows it. */
object SocialLogin {
    val busy = mutableStateOf(false)
    val error = mutableStateOf<String?>(null)
}

class MainActivity : ComponentActivity() {
    /** Text shared from another app, shown in a new note. */
    private val shared = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        shared.value = sharedText(intent)
        if (savedInstanceState == null) {
            finishSocialLogin(intent)
            hearTodayIfAsked(intent)
        }
        setContent {
            RecordAiTheme {
                AppRoot(repository, sharedText = shared.value, onSharedUsed = { shared.value = null })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        sharedText(intent)?.let { shared.value = it }
        finishSocialLogin(intent)
        hearTodayIfAsked(intent)
    }

    /** The "Hear today" shortcut (long-press the app icon): read the day straight away. */
    private fun hearTodayIfAsked(intent: Intent?) {
        if (intent?.action != HEAR_TODAY) return
        intent.action = Intent.ACTION_MAIN // once, not again after rotating the phone
        lifecycleScope.launch { hearToday(this@MainActivity, repository) }
    }

    companion object {
        const val HEAR_TODAY = "ai.record.android.HEAR_TODAY"
    }

    /** The browser came back to recordai://auth?code=… after "Continue with …". */
    private fun finishSocialLogin(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "recordai" || data.host != "auth") return
        SocialLogin.busy.value = true
        lifecycleScope.launch {
            runCatching { repository.socialLoginFinish(data.toString()) }
                .onFailure { SocialLogin.error.value = it.message ?: "Sign-in failed. Please try again." }
            SocialLogin.busy.value = false
        }
    }

    private fun sharedText(intent: Intent?): String? =
        if (intent?.action == Intent.ACTION_SEND) intent.getStringExtra(Intent.EXTRA_TEXT) else null
}

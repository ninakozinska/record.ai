package ai.record.android.ui

import ai.record.core.appLanguage
import ai.record.core.tr
import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.util.Locale

/** Reading notes aloud (Premium), with a voice of this phone chosen in the account screen. */
object ReadAloud {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: String? = null

    private fun prefs(context: Context) = context.getSharedPreferences("read_aloud", Context.MODE_PRIVATE)
    fun chosen(context: Context): String? = prefs(context).getString("voice", null)
    fun choose(context: Context, name: String) = prefs(context).edit().putString("voice", name).apply()
    fun rate(context: Context): Float = prefs(context).getFloat("rate", 1f)
    fun setRate(context: Context, rate: Float) = prefs(context).edit().putFloat("rate", rate).apply()

    fun init(context: Context) {
        if (tts != null) return
        val app = context.applicationContext
        tts = TextToSpeech(app) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) pending?.let { say(app, it) }
            pending = null
        }
    }

    /** The phone's voices that work offline, the app's language first. */
    fun voices(): List<Voice> {
        val all = runCatching { tts?.voices?.toList() }.getOrNull().orEmpty().filter { !it.isNetworkConnectionRequired }
        val mine = all.filter { it.locale.language == appLanguage }.sortedBy { it.name }
        return mine + (all - mine.toSet()).sortedBy { it.name }
    }

    /** Reads the text, or stops if something is being read. */
    fun speak(context: Context, text: String) {
        init(context)
        val t = tts ?: return
        if (t.isSpeaking) { t.stop(); return }
        if (!ready) { pending = text; return }
        say(context, text)
    }

    private fun say(context: Context, text: String) {
        val t = tts ?: return
        val voice = voices().firstOrNull { it.name == chosen(context) }
        if (voice != null) t.voice = voice else t.language = Locale(appLanguage)
        t.setSpeechRate(rate(context))
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "record-ai")
    }
}

/** The account screen's voice choice. */
@Composable
fun VoicePicker(premium: Boolean) {
    val context = LocalContext.current
    var voices by remember { mutableStateOf(emptyList<Voice>()) }
    var chosen by remember { mutableStateOf(ReadAloud.chosen(context)) }
    var rate by remember { mutableStateOf(ReadAloud.rate(context)) }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        ReadAloud.init(context)
        repeat(20) {
            voices = ReadAloud.voices()
            if (voices.isNotEmpty()) return@LaunchedEffect
            delay(250)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(tr("🔊 Read aloud"), style = MaterialTheme.typography.titleSmall)
        if (!premium) {
            Text(tr("Reading aloud is part of Premium."), style = MaterialTheme.typography.bodySmall)
            return@Column
        }
        Box {
            val label = voices.firstOrNull { it.name == chosen }?.let { "${it.locale.displayName} · ${it.name}" } ?: tr("Voice")
            OutlinedButton(onClick = { menu = true }, modifier = Modifier.fillMaxWidth()) { Text(label, maxLines = 1) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                voices.take(60).forEach { v ->
                    DropdownMenuItem(text = { Text("${v.locale.displayName} · ${v.name}") }, onClick = {
                        ReadAloud.choose(context, v.name); chosen = v.name; menu = false
                    })
                }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(0.8f to tr("Slow"), 1f to tr("Normal"), 1.2f to tr("Fast")).forEach { (r, label) ->
                FilterChip(selected = rate == r, onClick = { ReadAloud.setRate(context, r); rate = r }, label = { Text(label) })
            }
        }
        TextButton(onClick = { ReadAloud.speak(context, tr("Hello! This is how your notes will sound.")) }) { Text(tr("▶ Try it")) }
        Text(tr("Notes and your day read aloud, with the voice you like. The voices come from this device."),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

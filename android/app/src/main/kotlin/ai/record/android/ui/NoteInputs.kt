package ai.record.android.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import ai.record.android.ImageUtil
import ai.record.core.NoteRepository
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

/**
 * Text, dictation, camera and photo library. Used for new notes and in the editor.
 * Dictation and the camera use the phone's own apps, so record.ai needs no
 * microphone or camera permission.
 */
@Composable
fun NoteInputs(
    repo: NoteRepository,
    text: String,
    onText: (String) -> Unit,
    images: List<String>,
    onImages: (List<String>) -> Unit,
    placeholder: String = "Write a note, or tap the mic to dictate…",
    minLines: Int = 1,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraUri by remember { mutableStateOf<Uri?>(null) }

    // Keeps the latest values for callbacks that finish later (dictation, photos).
    val current by androidx.compose.runtime.rememberUpdatedState(Triple(text, images, onImages))

    val dictate = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: return@rememberLauncherForActivityResult
        val before = current.first
        onText(if (before.isBlank() || before.endsWith(" ") || before.endsWith("\n")) before + spoken else "$before $spoken")
    }

    val addPhotos: (List<Uri>) -> Unit = { uris ->
        scope.launch {
            val added = uris.mapNotNull { uri ->
                ImageUtil.prepare(context, uri)?.let { repo.addImage(it.full, it.thumb) }
            }
            if (added.isNotEmpty()) current.third(current.second + added)
        }
    }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = cameraUri
        if (saved && uri != null) addPhotos(listOf(uri))
    }
    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        if (uris.isNotEmpty()) addPhotos(uris)
    }

    Column(Modifier.fillMaxWidth()) {
        TextField(
            value = text,
            onValueChange = onText,
            placeholder = { Text(placeholder) },
            minLines = minLines,
            maxLines = 10,
            modifier = Modifier.fillMaxWidth(),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
            ),
        )
        if (images.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                images.forEach { name ->
                    Box(Modifier.size(64.dp)) {
                        NoteImage(repo, name, thumb = true, modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)))
                        IconButton(
                            onClick = { onImages(images - name) },
                            modifier = Modifier.align(Alignment.TopEnd).size(22.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape),
                        ) { Icon(Icons.Filled.Close, contentDescription = "Remove photo", tint = Color.White, modifier = Modifier.size(14.dp)) }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { startDictation(context) { dictate.launch(it) } }) {
                Icon(Icons.Outlined.Mic, contentDescription = "Dictate", tint = MaterialTheme.colorScheme.primary)
            }
            IconButton(onClick = {
                val uri = newCameraFile(context)
                cameraUri = uri
                try { takePhoto.launch(uri) } catch (e: ActivityNotFoundException) { toast(context, "No camera app found.") }
            }) { Icon(Icons.Outlined.PhotoCamera, contentDescription = "Take a photo", tint = MaterialTheme.colorScheme.primary) }
            IconButton(onClick = {
                pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) { Icon(Icons.Outlined.PhotoLibrary, contentDescription = "Add photos", tint = MaterialTheme.colorScheme.primary) }
        }
    }
}

private fun startDictation(context: Context, launch: (Intent) -> Unit) {
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your note")
    try {
        launch(intent)
    } catch (e: ActivityNotFoundException) {
        toast(context, "Speech recognition isn't available on this phone. Use the mic on your keyboard instead.")
    }
}

private fun newCameraFile(context: Context): Uri {
    val dir = File(context.cacheDir, "camera").apply { mkdirs() }
    // Old shots are only needed until they are stored; clear them.
    dir.listFiles()?.forEach { it.delete() }
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
}

internal fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_LONG).show()

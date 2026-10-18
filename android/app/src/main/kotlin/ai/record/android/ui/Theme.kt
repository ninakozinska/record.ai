package ai.record.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import ai.record.core.Priority

private val Indigo = Color(0xFF4F46E5)
private val IndigoLight = Color(0xFFA5B4FC)

@Composable
fun RecordAiTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = when {
        // Android 12+: match the colours of the phone's wallpaper.
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> darkColorScheme(primary = IndigoLight)
        else -> lightColorScheme(primary = Indigo)
    }
    MaterialTheme(colorScheme = colors, content = content)
}

val Priority.color: Color
    get() = when (this) {
        Priority.URGENT -> Color(0xFFDC2626)
        Priority.HIGH -> Color(0xFFEA7A0C)
        Priority.NORMAL -> Color(0xFF2563EB)
        Priority.LOW -> Color(0xFF8A8A9A)
    }

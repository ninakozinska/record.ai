package ai.record.core

import kotlinx.serialization.Serializable

/** One of the person's labels, like Gmail's: a name and a colour (see /api/labels). */
@Serializable data class Label(val name: String, val color: String = "gray")

/**
 * The person's labels, whether they may set them (labels are part of Premium),
 * and the colours the server accepts. Same rules as the web app (public/app.js).
 */
@Serializable data class LabelsState(
    val labels: List<Label> = emptyList(),
    val allowed: Boolean = false,
    val colors: List<String> = emptyList(),
) {
    /** A label's colour by name (any case); grey for one that is not in the list any more. */
    fun colorOf(name: String): String = labels.firstOrNull { it.name.equals(name, ignoreCase = true) }?.color ?: "gray"

    /** The list with a new label at the end (once, whatever its case), in the next colour. */
    fun adding(name: String): List<Label> {
        val clean = name.trim().take(40)
        if (clean.isEmpty() || labels.any { it.name.equals(clean, ignoreCase = true) }) return labels
        val palette = colors.ifEmpty { listOf("indigo") }
        return labels + Label(clean, palette[labels.size % palette.size])
    }

    /** The labels to offer in the note editor: mine, then any on the note that are no longer in my list. */
    fun choices(onNote: List<String>): List<String> =
        labels.map { it.name } + onNote.filter { n -> labels.none { it.name == n } }
}

object Labels {
    /** The note's labels with this one added, or taken off. */
    fun toggle(current: List<String>, name: String): List<String> = if (name in current) current - name else current + name

    /** A label colour as ARGB, the same palette as the web app's styles. */
    fun argb(color: String): Long = when (color) {
        "indigo" -> 0xFF4338CA
        "red" -> 0xFFB91C1C
        "orange" -> 0xFFC2410C
        "yellow" -> 0xFFA16207
        "green" -> 0xFF15803D
        "teal" -> 0xFF0F766E
        "blue" -> 0xFF1D4ED8
        "purple" -> 0xFF7E22CE
        "pink" -> 0xFFBE185D
        else -> 0xFF6B7280
    }
}

/** Searching notes, like the web app: every word must be found; "label:leo" finds notes with that label. */
object NoteSearch {
    /**
     * `fields` are the note's words (text, title, summary, group, tags, list items);
     * `labels` its labels. "label:school_trip" matches the label "School trip".
     */
    fun matches(fields: List<String>, labels: List<String>, query: String): Boolean {
        val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val lower = labels.map { it.lowercase() }
        val hay = (fields + lower).joinToString(" ").lowercase()
        return words.all { w ->
            if (w.startsWith("label:")) w.removePrefix("label:").replace('_', ' ') in lower else hay.contains(w)
        }
    }
}

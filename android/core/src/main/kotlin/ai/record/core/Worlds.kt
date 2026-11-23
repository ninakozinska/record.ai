package ai.record.core

/**
 * Work, Family and School: "worlds" over the same notes (same rules as the web
 * app's public/worlds.js). Each group belongs to one, guessed from its name,
 * and the person can move it; groups that fit none show in all.
 */
object Worlds {
    const val ALL = "all"
    const val WORK = "work"
    const val FAMILY = "family"
    const val SCHOOL = "school"
    /** A child's school group: "School · Leo". */
    const val SCHOOL_PREFIX = "School · "

    private val work = Regex(
        "\\b(work|office|job|meetings?|projects?|clients?|customers?|team|career|business|sales|marketing|boss|colleagues?|deadlines?|invoices?|conference|hiring|interviews?|reports?|admin)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val school = Regex(
        "\\b(schools?|homework|teachers?|classroom|class trip|school trip|exams?|pta|after-?school|daycare|nursery|kindergarten|preschool|tutoring|tutor|uniforms?|semester|report cards?|parent-teacher)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val family = Regex(
        "\\b(home|house|household|family|kids?|children|child|baby|groceries|grocery|shopping|chores|cleaning|garden|pets?|dog|cat|health|doctor|dentist|medical|partner|husband|wife|birthdays?|holidays?|vacation|travel|recipes?|cooking|meals?|dinner|car|finance|bills|budget|personal|friends|sports?|activities|social|leisure|entertainment|music|concerts?|theat(?:er|re)|cinema|movies?|parties|party|culture|hobbies)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** "work", "family" or null (both), from the group's name. */
    fun guess(group: String): String? {
        if (group.startsWith(SCHOOL_PREFIX) || school.containsMatchIn(group)) return SCHOOL
        val w = work.containsMatchIn(group)
        val f = family.containsMatchIn(group)
        return when {
            w && !f -> WORK
            f && !w -> FAMILY
            else -> null
        }
    }

    /** The person's choice for this group ("" = both) if they made one, else the guess. */
    fun of(group: String, chosen: Map<String, String>): String? {
        val key = group.lowercase()
        return if (key in chosen) chosen[key]?.ifEmpty { null } else guess(group)
    }

    fun shows(group: String, world: String, chosen: Map<String, String>): Boolean =
        world == ALL || (of(group, chosen) ?: world) == world

    /** "School" or a child's "School · Leo": what sharing all of School covers. */
    fun inSchool(group: String): Boolean = group.equals("School", ignoreCase = true) || group.startsWith(SCHOOL_PREFIX)

    /** The group for a child: "School · Leo". */
    fun childGroup(name: String): String = SCHOOL_PREFIX + name.trim()

    /** The child's name in "School · Leo"; other groups as they are. */
    fun childName(group: String): String = group.removePrefix(SCHOOL_PREFIX)

    /**
     * "🎒 Which child?": the children to offer for a school note the AI could not
     * place under one child. Empty when there is nothing to ask (done, shared with
     * me, already placed by the person, not in School, or no children yet).
     */
    fun childChoices(group: String, userGroup: String?, done: Boolean, shared: Boolean, myGroups: List<String>): List<String> {
        if (done || shared || !userGroup.isNullOrBlank() || !group.equals("School", ignoreCase = true)) return emptyList()
        return myGroups.filter { it.startsWith(SCHOOL_PREFIX) }
    }

    /** The person's groups shown even with no notes yet, after the groups that have notes. */
    fun withMyGroups(groups: List<String>, myGroups: List<String>): List<String> = groups + myGroups.filter { it !in groups }

    /** Does a share ("note", "group" or "school") cover this note, in this group? */
    fun covers(kind: String, target: String, noteId: String, group: String): Boolean = when (kind) {
        "note" -> target == noteId
        "school" -> inSchool(group)
        else -> target.equals(group, ignoreCase = true)
    }
}

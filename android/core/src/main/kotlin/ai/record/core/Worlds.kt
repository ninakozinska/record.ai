package ai.record.core

/**
 * Work and Family: two "worlds" over the same notes (same rules as the web
 * app's public/worlds.js). Each group belongs to one, guessed from its name,
 * and the person can move it; groups that fit neither show in both.
 */
object Worlds {
    const val ALL = "all"
    const val WORK = "work"
    const val FAMILY = "family"

    private val work = Regex(
        "\\b(work|office|job|meetings?|projects?|clients?|customers?|team|career|business|sales|marketing|boss|colleagues?|deadlines?|invoices?|conference|hiring|interviews?|reports?|admin)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val family = Regex(
        "\\b(home|house|household|family|kids?|children|child|baby|school|daycare|nursery|groceries|grocery|shopping|chores|cleaning|garden|pets?|dog|cat|health|doctor|dentist|medical|partner|husband|wife|birthdays?|holidays?|vacation|travel|recipes?|cooking|meals?|dinner|car|finance|bills|budget|personal|friends|sports?|activities)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** "work", "family" or null (both), from the group's name. */
    fun guess(group: String): String? {
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
}

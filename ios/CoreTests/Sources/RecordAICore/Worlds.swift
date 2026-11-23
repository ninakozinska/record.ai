import Foundation

/// Work, Family and School: "worlds" over the same notes (same rules as the web
/// app's public/worlds.js). Each group belongs to one, guessed from its name,
/// and the person can move it; groups that fit none show in all.
enum Worlds {
    static let all = "all", work = "work", family = "family", school = "school"
    /// A child's school group: "School · Leo".
    static let schoolPrefix = "School · "

    private static let workWords = try! NSRegularExpression(
        pattern: #"\b(work|office|job|meetings?|projects?|clients?|customers?|team|career|business|sales|marketing|boss|colleagues?|deadlines?|invoices?|conference|hiring|interviews?|reports?|admin)\b"#,
        options: .caseInsensitive)
    private static let schoolWords = try! NSRegularExpression(
        pattern: #"\b(schools?|homework|teachers?|classroom|class trip|school trip|exams?|pta|after-?school|daycare|nursery|kindergarten|preschool|tutoring|tutor|uniforms?|semester|report cards?|parent-teacher)\b"#,
        options: .caseInsensitive)
    private static let familyWords = try! NSRegularExpression(
        pattern: #"\b(home|house|household|family|kids?|children|child|baby|groceries|grocery|shopping|chores|cleaning|garden|pets?|dog|cat|health|doctor|dentist|medical|partner|husband|wife|birthdays?|holidays?|vacation|travel|recipes?|cooking|meals?|dinner|car|finance|bills|budget|personal|friends|sports?|activities|social|leisure|entertainment|music|concerts?|theat(?:er|re)|cinema|movies?|parties|party|culture|hobbies)\b"#,
        options: .caseInsensitive)

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// "work", "family" or nil (both), from the group's name.
    static func guess(_ group: String) -> String? {
        if group.hasPrefix(schoolPrefix) || matches(schoolWords, group) { return school }
        let w = matches(workWords, group), f = matches(familyWords, group)
        if w && !f { return work }
        if f && !w { return family }
        return nil
    }

    /// The person's choice for this group ("" = both) if they made one, else the guess.
    static func of(_ group: String, chosen: [String: String]) -> String? {
        if let c = chosen[group.lowercased()] { return c.isEmpty ? nil : c }
        return guess(group)
    }

    static func shows(_ group: String, in world: String, chosen: [String: String]) -> Bool {
        world == all || (of(group, chosen: chosen) ?? world) == world
    }

    /// "School" or a child's "School · Leo": what sharing all of School covers.
    static func inSchool(_ group: String) -> Bool {
        group.lowercased() == "school" || group.hasPrefix(schoolPrefix)
    }

    /// The group for a child: "School · Leo".
    static func childGroup(_ name: String) -> String {
        schoolPrefix + name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The child's name in "School · Leo"; other groups as they are.
    static func childName(_ group: String) -> String {
        group.hasPrefix(schoolPrefix) ? String(group.dropFirst(schoolPrefix.count)) : group
    }

    /// "🎒 Which child?": the children to offer for a school note the AI could not
    /// place under one child. Empty when there is nothing to ask (done, shared with
    /// me, already placed by the person, not in School, or no children yet).
    static func childChoices(group: String, userGroup: String?, done: Bool, shared: Bool, myGroups: [String]) -> [String] {
        if done || shared || !(userGroup ?? "").isEmpty || group.lowercased() != "school" { return [] }
        return myGroups.filter { $0.hasPrefix(schoolPrefix) }
    }

    /// The person's groups shown even with no notes yet, after the groups that have notes.
    static func withMyGroups(_ groups: [String], _ myGroups: [String]) -> [String] {
        groups + myGroups.filter { !groups.contains($0) }
    }

    /// Does a share ("note", "group" or "school") cover this note, in this group?
    static func covers(kind: String, target: String, noteId: String, group: String) -> Bool {
        switch kind {
        case "note": return target == noteId
        case "school": return inSchool(group)
        default: return target.lowercased() == group.lowercased()
        }
    }
}

struct WorldChoices: Codable {
    var chosen: [String: String]
}

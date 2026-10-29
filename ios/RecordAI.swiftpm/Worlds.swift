import Foundation

/// Work and Family: two "worlds" over the same notes (same rules as the web
/// app's public/worlds.js). Each group belongs to one, guessed from its name,
/// and the person can move it; groups that fit neither show in both.
enum Worlds {
    static let all = "all", work = "work", family = "family"

    private static let workWords = try! NSRegularExpression(
        pattern: #"\b(work|office|job|meetings?|projects?|clients?|customers?|team|career|business|sales|marketing|boss|colleagues?|deadlines?|invoices?|conference|hiring|interviews?|reports?|admin)\b"#,
        options: .caseInsensitive)
    private static let familyWords = try! NSRegularExpression(
        pattern: #"\b(home|house|household|family|kids?|children|child|baby|school|daycare|nursery|groceries|grocery|shopping|chores|cleaning|garden|pets?|dog|cat|health|doctor|dentist|medical|partner|husband|wife|birthdays?|holidays?|vacation|travel|recipes?|cooking|meals?|dinner|car|finance|bills|budget|personal|friends|sports?|activities)\b"#,
        options: .caseInsensitive)

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// "work", "family" or nil (both), from the group's name.
    static func guess(_ group: String) -> String? {
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
}

struct WorldChoices: Codable {
    var chosen: [String: String]
}

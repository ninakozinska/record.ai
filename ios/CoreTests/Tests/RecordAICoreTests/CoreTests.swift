import XCTest
@testable import RecordAICore

final class WorldsTests: XCTestCase {
    func testSameRulesAsTheWebApp() {
        XCTAssertEqual(Worlds.guess("Client projects"), Worlds.work)
        XCTAssertEqual(Worlds.guess("Groceries"), Worlds.family)
        XCTAssertNil(Worlds.guess("Ideas"))
        XCTAssertNil(Worlds.guess("Work from home"))
        XCTAssertEqual(Worlds.of("Ideas", chosen: ["ideas": "work"]), Worlds.work)
        XCTAssertNil(Worlds.of("Kids", chosen: ["kids": ""]))
        XCTAssertTrue(Worlds.shows("Ideas", in: Worlds.work, chosen: [:]))
        XCTAssertFalse(Worlds.shows("Kids", in: Worlds.work, chosen: [:]))
    }
}

final class SchoolTests: XCTestCase {
    func testWhichChildIsAskedOnlyForUnplacedSchoolNotes() {
        let kids = ["Work", "School · Leo", "School · Mia"]
        XCTAssertEqual(Worlds.childChoices(group: "School", userGroup: nil, done: false, shared: false, myGroups: kids), ["School · Leo", "School · Mia"])
        XCTAssertEqual(Worlds.childChoices(group: "School", userGroup: "School", done: false, shared: false, myGroups: kids), [])
        XCTAssertEqual(Worlds.childChoices(group: "School", userGroup: nil, done: true, shared: false, myGroups: kids), [])
        XCTAssertEqual(Worlds.childChoices(group: "School", userGroup: nil, done: false, shared: true, myGroups: kids), [])
        XCTAssertEqual(Worlds.childChoices(group: "Groceries", userGroup: nil, done: false, shared: false, myGroups: kids), [])
        XCTAssertEqual(Worlds.childChoices(group: "School", userGroup: nil, done: false, shared: false, myGroups: ["Work"]), [])
        XCTAssertEqual(Worlds.childGroup(" Leo "), "School · Leo")
        XCTAssertEqual(Worlds.childName("School · Leo"), "Leo")
    }

    func testSchoolGroupsMyGroupsAndShares() {
        XCTAssertTrue(Worlds.inSchool("school"))
        XCTAssertTrue(Worlds.inSchool("School · Leo"))
        XCTAssertFalse(Worlds.inSchool("Schoolbooks"))
        XCTAssertEqual(Worlds.guess("School · Leo"), Worlds.school)
        XCTAssertEqual(Worlds.withMyGroups(["Home", "Work"], ["Work", "School · Leo"]), ["Home", "Work", "School · Leo"])
        XCTAssertTrue(Worlds.covers(kind: "school", target: "School", noteId: "n1", group: "School · Mia"))
        XCTAssertFalse(Worlds.covers(kind: "school", target: "School", noteId: "n1", group: "Groceries"))
        XCTAssertTrue(Worlds.covers(kind: "group", target: "groceries", noteId: "n1", group: "Groceries"))
        XCTAssertTrue(Worlds.covers(kind: "note", target: "n1", noteId: "n1", group: "Anything"))
        XCTAssertFalse(Worlds.covers(kind: "note", target: "n2", noteId: "n1", group: "Anything"))
    }
}

final class LabelsTests: XCTestCase {
    private let state = LabelsState(labels: [NoteLabel(name: "Leo", color: "blue"), NoteLabel(name: "Bills", color: "red")],
                                    allowed: true, colors: ["indigo", "red", "orange"])

    func testANewLabelIsAddedOnceInTheNextColour() {
        XCTAssertEqual(state.adding(" Doctor ").map(\.name), ["Leo", "Bills", "Doctor"])
        XCTAssertEqual(state.adding("Doctor").last?.color, "orange")
        XCTAssertEqual(state.adding("leo"), state.labels)
        XCTAssertEqual(state.adding("  "), state.labels)
        XCTAssertEqual(LabelsState().adding("First").first?.color, "indigo")
    }

    func testColoursAndEditorChoices() {
        XCTAssertEqual(state.color(of: "leo"), "blue")
        XCTAssertEqual(state.color(of: "Old label"), "gray")
        XCTAssertEqual(state.choices(onNote: ["Bills", "Old label"]), ["Leo", "Bills", "Old label"])
        XCTAssertEqual(Labels.toggle(["Leo"], "Bills"), ["Leo", "Bills"])
        XCTAssertEqual(Labels.toggle(["Leo"], "Leo"), [])
    }

    func testSearchFindsWordsAndLabelColon() {
        let fields = ["Pay the swim club", "Swimming", "Family"]
        XCTAssertTrue(NoteSearch.matches(fields: fields, labels: ["Leo"], query: ""))
        XCTAssertTrue(NoteSearch.matches(fields: fields, labels: ["Leo"], query: "swim club"))
        XCTAssertTrue(NoteSearch.matches(fields: fields, labels: ["Leo"], query: "leo"))
        XCTAssertTrue(NoteSearch.matches(fields: fields, labels: ["Leo"], query: "label:leo swim"))
        XCTAssertFalse(NoteSearch.matches(fields: fields, labels: ["Leo"], query: "label:bills"))
        XCTAssertFalse(NoteSearch.matches(fields: fields, labels: ["Leonardo"], query: "label:leo"))
        XCTAssertTrue(NoteSearch.matches(fields: fields, labels: ["School trip"], query: "label:school_trip"))
    }
}

final class TranslationsTests: XCTestCase {
    func testEnglishOrThePhonesLanguage() {
        let cancel = tr("Cancel")
        XCTAssertTrue(["Cancel", "Annulla", "Annuler", "Cancelar", "Abbrechen", "Anuluj"].contains(cancel))
        XCTAssertEqual(tr("A phrase nobody translated"), "A phrase nobody translated")
    }
}

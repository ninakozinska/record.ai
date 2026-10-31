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

final class TranslationsTests: XCTestCase {
    func testEnglishOrThePhonesLanguage() {
        let cancel = tr("Cancel")
        XCTAssertTrue(["Cancel", "Annulla", "Annuler", "Cancelar", "Abbrechen", "Anuluj"].contains(cancel))
        XCTAssertEqual(tr("A phrase nobody translated"), "A phrase nobody translated")
    }
}

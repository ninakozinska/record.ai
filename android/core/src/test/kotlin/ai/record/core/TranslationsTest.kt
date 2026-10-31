package ai.record.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class TranslationsTest {
    private val before = appLanguage

    @AfterTest
    fun restore() {
        appLanguage = before
    }

    @Test
    fun phrasesFollowThePhonesLanguage() {
        appLanguage = "it"
        assertEquals("Annulla", tr("Cancel"))
        appLanguage = "pl"
        assertEquals("Usuń notatkę", tr("Delete note"))
        appLanguage = "en"
        assertEquals("Cancel", tr("Cancel"))
    }

    @Test
    fun anUnknownPhraseStaysEnglish() {
        appLanguage = "de"
        assertEquals("Something new", tr("Something new"))
    }
}

package ai.record.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * "Continue with Google" from the phone, against the real server code with a
 * fake Google (test/fixtures/fake-google-server.mjs). The browser's part is
 * played by plain HTTP requests that don't follow redirects.
 */
class SocialLoginTest {
    private lateinit var server: Process
    private lateinit var url: String
    private val browser = OkHttpClient.Builder().followRedirects(false).build()

    @BeforeTest fun startServer() {
        val root = File(System.getProperty("recordai.root") ?: "../..")
        val port = ServerSocket(0).use { it.localPort }
        url = "http://127.0.0.1:$port"
        server = ProcessBuilder("node", "--disable-warning=ExperimentalWarning", "test/fixtures/fake-google-server.mjs")
            .directory(root)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .apply {
                environment()["PORT"] = port.toString()
                environment()["DATA_DIR"] = Files.createTempDirectory("recordai-server").toString()
                environment()["AI_PROVIDER"] = "none"
            }
            .start()
        val deadline = System.currentTimeMillis() + 15_000
        while (runCatching { URI("$url/api/health").toURL().readText().contains("ok") }.getOrDefault(false).not()) {
            check(System.currentTimeMillis() < deadline) { "server did not start" }
            Thread.sleep(100)
        }
    }

    @AfterTest fun stopServer() {
        server.destroy()
    }

    /** What the browser does: start → (Google) → callback page that opens recordai://auth?… */
    private fun browse(startUrl: String): String {
        val toGoogle = browser.newCall(Request.Builder().url(startUrl).build()).execute().use { it.header("Location")!! }
        val google = OAuthSecret.query(toGoogle)
        assertEquals("test", google["client_id"])
        val callback = "${google["redirect_uri"]}?state=${google["state"]}&code=fake-code"
        val page = browser.newCall(Request.Builder().url(callback).build()).execute().use { it.body!!.string() }
        return Regex("""href="(recordai://auth\?[^"]+)"""").find(page)!!.groupValues[1].replace("&#38;", "&")
    }

    @Test fun `PKCE fingerprints match the standard's example`() {
        // RFC 7636, appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", OAuthSecret.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        assertEquals(43, OAuthSecret.make().length)
        assertEquals(mapOf("code" to "a b", "x" to "1"), OAuthSecret.query("recordai://auth?code=a+b&x=1"))
    }

    @Test fun `continue with Google signs the phone in`() = runBlocking<Unit> {
        val secrets = MemorySecretStore()
        val phone = NoteRepository(FileStorage(Files.createTempDirectory("recordai-phone").toFile()), secrets, CoroutineScope(SupervisorJob()))
        phone.connect(url)
        assertEquals(listOf(AuthProvider("google", "Google")), phone.state.value.providers)

        val start = phone.socialLoginUrl("google")!!
        assertNotNull(secrets.oauthVerifier, "secret kept until the browser comes back")
        val back = browse(start)
        phone.socialLoginFinish(back)
        assertEquals("Nina from Google", phone.state.value.user?.name)
        assertNull(secrets.oauthVerifier, "secret used once")
        assertNotNull(secrets.token)

        val info = phone.accountInfo()!!
        assertEquals(false, info.hasPassword)
        assertEquals(listOf("google"), info.identities.map { it.provider })

        // The same code cannot be used twice, and errors from the server reach the screen.
        assertFailsWith<ApiException> { phone.socialLoginFinish(back) }
        val cancelled = assertFailsWith<ApiException> { phone.socialLoginFinish("recordai://auth?error=Sign-in+was+cancelled.") }
        assertEquals("Sign-in was cancelled.", cancelled.message)
    }

    @Test fun `a code is useless without this phone's secret`() = runBlocking<Unit> {
        val phone = NoteRepository(FileStorage(Files.createTempDirectory("recordai-a").toFile()), MemorySecretStore(), CoroutineScope(SupervisorJob()))
        phone.connect(url)
        val back = browse(phone.socialLoginUrl("google")!!)
        // Another app catches recordai://auth?code=… but has a different secret.
        val thief = MemorySecretStore()
        val other = NoteRepository(FileStorage(Files.createTempDirectory("recordai-b").toFile()), thief, CoroutineScope(SupervisorJob()))
        other.connect(url)
        other.socialLoginUrl("google")
        val e = assertFailsWith<ApiException> { other.socialLoginFinish(back) }
        assertTrue(e.message!!.contains("expired"))
        assertNull(other.state.value.user)
    }
}

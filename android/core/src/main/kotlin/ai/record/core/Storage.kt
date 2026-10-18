package ai.record.core

import java.io.File

/** Where the app keeps notes, photos and settings on the device. */
interface Storage {
    fun loadCache(): CacheState?
    fun saveCache(state: CacheState)
    fun imageFile(name: String): File
    fun clearData()
    var serverUrl: String?
    var user: User?
}

/** Keeps the login token secret (on Android: encrypted with a key in the Android Keystore). */
interface SecretStore {
    var token: String?
    /** The secret of a "Continue with …" sign-in in progress (survives the app being closed meanwhile). */
    var oauthVerifier: String?
}

/** Plain files in an app-private folder. */
class FileStorage(private val dir: File) : Storage {
    private val cacheFile get() = File(dir, "notes.json")
    private val settingsFile get() = File(dir, "settings.json")
    private val imagesDir get() = File(dir, "images").apply { mkdirs() }

    init { dir.mkdirs() }

    override fun loadCache(): CacheState? =
        runCatching { json.decodeFromString(CacheState.serializer(), cacheFile.readText()) }.getOrNull()

    override fun saveCache(state: CacheState) {
        // Write to a temporary file, then rename: a crash never leaves half a file.
        val tmp = File(dir, "notes.json.tmp")
        tmp.writeText(json.encodeToString(CacheState.serializer(), state))
        if (!tmp.renameTo(cacheFile)) { cacheFile.delete(); tmp.renameTo(cacheFile) }
    }

    override fun imageFile(name: String) = File(imagesDir, name)

    override fun clearData() {
        cacheFile.delete()
        imagesDir.deleteRecursively()
    }

    @kotlinx.serialization.Serializable
    private data class Settings(val serverUrl: String? = null, val user: User? = null)

    private var settings: Settings
        get() = runCatching { json.decodeFromString(Settings.serializer(), settingsFile.readText()) }.getOrDefault(Settings())
        set(value) = settingsFile.writeText(json.encodeToString(Settings.serializer(), value))

    override var serverUrl: String?
        get() = settings.serverUrl
        set(value) { settings = settings.copy(serverUrl = value) }

    override var user: User?
        get() = settings.user
        set(value) { settings = settings.copy(user = value) }
}

class MemorySecretStore(override var token: String? = null, override var oauthVerifier: String? = null) : SecretStore

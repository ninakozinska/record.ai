package ai.record.android

import android.app.Application
import ai.record.core.FileStorage
import ai.record.core.NoteRepository
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File

/** Creates the one note repository the whole app shares, and follows the app's foreground/background state. */
class RecordAiApplication : Application() {
    lateinit var repository: NoteRepository
        private set

    override fun onCreate() {
        super.onCreate()
        repository = NoteRepository(
            storage = FileStorage(File(filesDir, "record.ai")),
            secrets = KeystoreSecretStore(this),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            // In front: live updates on. In the background: off (saves battery),
            // and any unsent change is handed to Android to send when online.
            override fun onStart(owner: LifecycleOwner) = repository.start()
            override fun onStop(owner: LifecycleOwner) {
                repository.stopLive()
                if (repository.state.value.unsent > 0) SyncWorker.schedule(this@RecordAiApplication)
            }
        })
    }
}

val android.content.Context.repository: NoteRepository
    get() = (applicationContext as RecordAiApplication).repository

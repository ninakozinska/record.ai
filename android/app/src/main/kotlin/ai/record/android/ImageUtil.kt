package ai.record.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.LruCache
import androidx.exifinterface.media.ExifInterface
import ai.record.core.NoteRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max

object ImageUtil {
    /** A photo ready to store: the full JPEG (max 1600 px) and a preview (max 320 px). */
    class Prepared(val full: ByteArray, val thumb: ByteArray)

    /** Reads a photo, turns it upright, shrinks it and encodes it as JPEG. */
    suspend fun prepare(context: Context, uri: Uri): Prepared? = withContext(Dispatchers.IO) {
        runCatching {
            val resolver = context.contentResolver
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            // Decode at a reduced size straight away: a 12 MP photo never fully enters memory.
            val sample = sampleSize(max(bounds.outWidth, bounds.outHeight), 1600)
            val decoded = resolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
            } ?: return@runCatching null
            val rotation = resolver.openInputStream(uri)?.use { ExifInterface(it).rotationDegrees } ?: 0
            val upright = if (rotation != 0) {
                Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
            } else decoded
            Prepared(full = jpeg(upright, 1600, 85), thumb = jpeg(upright, 320, 70))
        }.getOrNull()
    }

    private fun sampleSize(longest: Int, target: Int): Int {
        var s = 1
        while (longest / (s * 2) >= target) s *= 2
        return s
    }

    private fun jpeg(src: Bitmap, maxSide: Int, quality: Int): ByteArray {
        val scale = minOf(1f, maxSide.toFloat() / max(src.width, src.height))
        val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true) else src
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
    }

    // Decoded photos kept in memory (up to 1/8 of the app's memory), so scrolling is smooth.
    private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 8 / 1024).toInt()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }

    /** A photo or its preview, decoded at about the size it is shown. */
    suspend fun load(repo: NoteRepository, name: String, thumb: Boolean): Bitmap? {
        val key = if (thumb) "$name#thumb" else name
        cache.get(key)?.let { return it }
        val bytes = repo.image(name, thumb) ?: return null
        val bitmap = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(max(bounds.outWidth, bounds.outHeight), if (thumb) 320 else 1600) }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        } ?: return null
        cache.put(key, bitmap)
        return bitmap
    }
}

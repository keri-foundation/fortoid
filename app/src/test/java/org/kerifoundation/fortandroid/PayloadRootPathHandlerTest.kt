package org.kerifoundation.fortandroid

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * Tests for PayloadRootPathHandler fallback-removal behavior.
 *
 * Proves:
 * - Valid assets return non-null responses with correct bytes.
 * - Missing subordinate assets return null (no placeholder substitution).
 * - Missing main entrypoint returns null (no alternate shell).
 * - No branch references the obsolete PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH.
 */
class PayloadRootPathHandlerTest {

    /** A test double that returns a fixed response for known paths, null otherwise. */
    private class TestAssetsHandler(
        private val assets: Map<String, ByteArray>
    ) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val bytes = assets[path] ?: return null
            return WebResourceResponse(
                "application/octet-stream",
                null,
                ByteArrayInputStream(bytes)
            )
        }
    }

    private fun handlerWith(assets: Map<String, String>): MainActivity.PayloadRootPathHandler {
        val byteAssets = assets.mapValues { (_, v) -> v.toByteArray() }
        return MainActivity.PayloadRootPathHandler(TestAssetsHandler(byteAssets))
    }

    // ── Valid asset resolution ────────────────────────────────────────────

    @Test
    fun `valid payload asset returns non-null response`() {
        val handler = handlerWith(mapOf("payload/index.html" to "<html></html>"))
        val response = handler.handle("/")
        assertNotNull("entrypoint must be found", response)
    }

    @Test
    fun `valid payload asset returns correct bytes`() {
        val content = "<html><body>hello</body></html>"
        val handler = handlerWith(mapOf("payload/index.html" to content))
        val response = handler.handle("/")
        assertNotNull(response)
        val bytes = response!!.data.readBytes()
        assertEquals("returned bytes must match asset", content, String(bytes))
    }

    @Test
    fun `subpath asset is resolved correctly`() {
        val content = "console.log('main')"
        val handler = handlerWith(mapOf("payload/app/main.js" to content))
        val response = handler.handle("app/main.js")
        assertNotNull(response)
        val bytes = response!!.data.readBytes()
        assertEquals(content, String(bytes))
    }

    @Test
    fun `path with payload-prefix passes through unchanged`() {
        val content = "{}"
        val handler = handlerWith(mapOf("payload/contracts/runtime-requirements.json" to content))
        val response = handler.handle("payload/contracts/runtime-requirements.json")
        assertNotNull(response)
        val bytes = response!!.data.readBytes()
        assertEquals(content, String(bytes))
    }

    // ── Missing assets → null (no fallback) ───────────────────────────────

    @Test
    fun `missing subordinate asset returns null`() {
        val handler = handlerWith(mapOf("payload/index.html" to "present"))
        val response = handler.handle("missing-file.js")
        assertNull("missing subordinate asset must return null", response)
    }

    @Test
    fun `missing main entrypoint returns null`() {
        val handler = handlerWith(emptyMap())
        val response = handler.handle("/")
        assertNull("missing entrypoint must return null", response)
    }

    @Test
    fun `empty path with missing entrypoint returns null`() {
        val handler = handlerWith(mapOf("payload/other.txt" to "data"))
        val response = handler.handle("")
        assertNull("empty path with missing index must return null", response)
    }

    // ── Old placeholder not reachable ─────────────────────────────────────

    @Test
    fun `old placeholder asset is not substituted for missing entrypoint`() {
        val handler = handlerWith(mapOf(
            "bootstrap/payload-missing.html" to "<html><body>OLD PLACEHOLDER</body></html>"
        ))
        val response = handler.handle("/")
        assertNull(
            "must not substitute bootstrap/payload-missing.html for missing entrypoint",
            response
        )
    }

    @Test
    fun `old placeholder asset is not substituted for missing subordinate`() {
        val handler = handlerWith(mapOf(
            "payload/index.html" to "present",
            "bootstrap/payload-missing.html" to "<html>PLACEHOLDER</html>"
        ))
        val response = handler.handle("missing.css")
        assertNull(
            "must not substitute placeholder for missing subordinate asset",
            response
        )
    }

    // ── Obsolete constant verification ───────────────────────────────────

    @Test
    fun `PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH constant is removed`() {
        val field = MainActivity::class.java.declaredFields
            .find { it.name == "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH" }
        assertNull(
            "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH must not exist in compiled class",
            field
        )
    }

    // ── Path normalization ────────────────────────────────────────────────

    @Test
    fun `leading slash is stripped for path normalization`() {
        val content = "data"
        val handler = handlerWith(mapOf("payload/app/data.txt" to content))
        val response = handler.handle("/app/data.txt")
        assertNotNull(response)
        assertEquals(content, String(response!!.data.readBytes()))
    }

    @Test
    fun `empty path resolves to index asset path`() {
        val content = "index"
        val handler = handlerWith(mapOf("payload/index.html" to content))
        val response = handler.handle("")
        assertNotNull(response)
        assertEquals(content, String(response!!.data.readBytes()))
    }
}

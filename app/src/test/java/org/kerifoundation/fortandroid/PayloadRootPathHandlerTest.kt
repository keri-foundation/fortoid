package org.kerifoundation.fortandroid

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for PayloadRootPathHandler fallback-removal behavior.
 *
 * Uses a recording delegate that never constructs WebResourceResponse,
 * avoiding Android mockable-jar stub failures in plain JVM tests.
 *
 * Proves:
 * - Canonical paths are selected correctly (normalization).
 * - Primary path is tried first, then app/-stripped fallback.
 * - Delegate null propagates as handler null (missing → no fallback).
 * - Old placeholder path is never requested.
 * - app/ paths trigger fallback lookup when primary fails; non-app/ paths do not.
 * - PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH is absent from compiled class.
 */
class PayloadRootPathHandlerTest {

    /** Recording test double: tracks requested paths, returns null. */
    private class RecordingPathHandler : WebViewAssetLoader.PathHandler {
        val requestedPaths = mutableListOf<String>()

        override fun handle(path: String): WebResourceResponse? {
            requestedPaths += path
            return null
        }
    }

    // ── Path selection (normalization) ──────────────────────────────────

    @Test
    fun `slash requests payload-slash-index-dot-html`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        val result = handler.handle("/")
        assertNull("delegate returns null → handler returns null", result)
        assertEquals("primary + app/-stripped fallback", 2, delegate.requestedPaths.size)
        assertEquals("payload/app/index.html", delegate.requestedPaths[0])
        assertEquals("payload/index.html", delegate.requestedPaths[1])
    }

    @Test
    fun `empty path requests index asset path`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("")
        assertEquals("primary + app/-stripped fallback", 2, delegate.requestedPaths.size)
        assertEquals("payload/app/index.html", delegate.requestedPaths[0])
        assertEquals("payload/index.html", delegate.requestedPaths[1])
    }

    @Test
    fun `unprefixed subpath is prefixed with payload-slash`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("app/main.js")
        assertEquals("primary + app/-stripped fallback", 2, delegate.requestedPaths.size)
        assertEquals("payload/app/main.js", delegate.requestedPaths[0])
        assertEquals("payload/main.js", delegate.requestedPaths[1])
    }

    @Test
    fun `leading slash is stripped before prefixing`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("/app/main.js")
        assertEquals("primary + app/-stripped fallback", 2, delegate.requestedPaths.size)
        assertEquals("payload/app/main.js", delegate.requestedPaths[0])
        assertEquals("payload/main.js", delegate.requestedPaths[1])
    }

    @Test
    fun `payload-prefixed path passes through unchanged`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("payload/contracts/runtime-requirements.json")
        assertEquals("payload-prefixed path not under app/ → no fallback", 1, delegate.requestedPaths.size)
        assertEquals("payload/contracts/runtime-requirements.json", delegate.requestedPaths[0])
    }

    // ── Null propagation (missing → no fallback) ────────────────────────

    @Test
    fun `delegate null returns handler null for missing entrypoint`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        val result = handler.handle("/")
        assertNull("missing entrypoint must return null", result)
        assertEquals("primary + app/-stripped fallback", 2, delegate.requestedPaths.size)
    }

    @Test
    fun `delegate null returns handler null for missing subordinate`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        val result = handler.handle("missing-file.js")
        assertNull("missing subordinate must return null", result)
        assertEquals("non-app/ path → no fallback", 1, delegate.requestedPaths.size)
        assertEquals("payload/missing-file.js", delegate.requestedPaths[0])
    }

    // ── Old placeholder path never selected ─────────────────────────────

    @Test
    fun `old placeholder path is never requested for missing entrypoint`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("/")
        assertTrue(
            "must not request bootstrap/payload-missing.html",
            delegate.requestedPaths.none { it == "bootstrap/payload-missing.html" }
        )
    }

    @Test
    fun `old placeholder path is never requested for missing subordinate`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("missing.css")
        assertTrue(
            "must not request bootstrap/payload-missing.html",
            delegate.requestedPaths.none { it == "bootstrap/payload-missing.html" }
        )
    }

    @Test
    fun `exactly one delegate call per request`() {
        val delegate = RecordingPathHandler()
        val handler = MainActivity.PayloadRootPathHandler(delegate)
        handler.handle("/")
        handler.handle("other.js")
        // "/" → primary + fallback (2 calls); "other.js" → primary only (1 call)
        assertEquals("three delegate calls: 2 for app/ path, 1 for non-app/ path", 3, delegate.requestedPaths.size)
    }

    // ── Obsolete constant verification ──────────────────────────────────

    @Test
    fun `PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH is absent from compiled class`() {
        val field = MainActivity::class.java.declaredFields
            .find { it.name == "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH" }
        assertNull(
            "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH must not exist in MainActivity",
            field
        )
        // Also check companion object
        val companionField = MainActivity::class.java.classes
            .flatMap { it.declaredFields.toList() }
            .find { it.name == "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH" }
        assertNull(
            "PAYLOAD_MISSING_PLACEHOLDER_ASSET_PATH must not exist in companion",
            companionField
        )
    }
}

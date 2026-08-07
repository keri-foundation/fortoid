package org.kerifoundation.fortandroid

import android.app.Activity
import android.os.Bundle
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Instrumentation test proving dedicated Web Worker message round-trip
 * in an Android WebView under production-equivalent configuration.
 *
 * Evidence classification: PLATFORM-WORKER-BASELINE
 * — proves static same-origin Worker loads, executes, and completes
 *   a message round-trip.
 * — does NOT prove Pyodide worker execution.
 */

/** Minimal test-only Activity hosting a single WebView. */
class WorkerProbeActivity : Activity() {
    lateinit var webView: WebView
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        configureRuntimeSettings(webView.settings)
        setContentView(webView)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

// ── Production-equivalent configuration (no MainActivity refactor) ────────

/** Apply the same WebSettings used in production MainActivity. */
fun configureRuntimeSettings(settings: WebSettings) {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.allowFileAccessFromFileURLs = false
    settings.allowUniversalAccessFromFileURLs = false
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.mediaPlaybackRequiresUserGesture = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    settings.setSupportMultipleWindows(false)
}

/** Reproduce production COOP/COEP/CORP headers. */
fun addProductionSecurityHeaders(response: WebResourceResponse): WebResourceResponse {
    val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
    headers["Cross-Origin-Opener-Policy"] = "same-origin"
    headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.responseHeaders = headers
    return response
}

/** WebViewAssetLoader-backed PathHandler for androidTest assets. */
class TestAssetPathHandler(
    private val assetsPathHandler: WebViewAssetLoader.AssetsPathHandler
) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val response = assetsPathHandler.handle(path) ?: return null
        return addProductionSecurityHeaders(response)
    }
}

@RunWith(AndroidJUnit4::class)
class WorkerRuntimeProofTest {

    private lateinit var scenario: ActivityScenario<WorkerProbeActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun createAssetLoader(context: android.content.Context): WebViewAssetLoader {
        // Use instrumentation context for androidTest assets
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(context)
        val pathHandler = TestAssetPathHandler(assetsHandler)
        return WebViewAssetLoader.Builder()
            .addPathHandler("/", pathHandler)
            .setDomain("appassets.androidplatform.net")
            .setHttpAllowed(true)
            .build()
    }

    private fun loadPageAndPoll(
        activity: WorkerProbeActivity,
        pagePath: String,
        timeoutSeconds: Long = 15
    ): Map<String, Any?> {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val loader = createAssetLoader(instrCtx)
        val url = "https://appassets.androidplatform.net/$pagePath"
        val resultLatch = CountDownLatch(1)
        val resultHolder = arrayOf<Map<String, Any?>?>(null)

        activity.runOnUiThread {
            activity.webView.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: android.webkit.WebResourceRequest
                ): WebResourceResponse? {
                    return loader.shouldInterceptRequest(request.url)
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    view.postDelayed({ pollForResult(view, resultHolder, resultLatch) }, 500)
                }
            }
            activity.webView.loadUrl(url)
        }

        assertTrue("timeout waiting for worker result", resultLatch.await(timeoutSeconds, TimeUnit.SECONDS))
        assertNotNull("probe result must not be null", resultHolder[0])
        return resultHolder[0]!!
    }

    private fun pollForResult(view: WebView, holder: Array<Map<String, Any?>?>, latch: CountDownLatch) {
        view.evaluateJavascript(
            "(function(){return JSON.stringify(window.__workerProbeResult||{state:'unknown'});})()"
        ) { json ->
            val trimmed = json?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try {
                val result = org.json.JSONObject(trimmed)
                val state = result.optString("state", "unknown")
                if (state == "done" || state == "error") {
                    val map = mutableMapOf<String, Any?>()
                    for (key in result.keys()) {
                        map[key] = result.get(key)
                    }
                    holder[0] = map
                    latch.countDown()
                } else {
                    view.postDelayed({ pollForResult(view, holder, latch) }, 300)
                }
            } catch (_: Exception) {
                view.postDelayed({ pollForResult(view, holder, latch) }, 300)
            }
        }
    }

    // ── Tests ────────────────────────────────────────────────────────────

    @Test
    fun dedicatedWorkerCompletesSameOriginRoundTrip() {
        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val result = loadPageAndPoll(activity, "worker-probe/index.html")
            // Assertions on test thread (not UI thread)
            assertEquals("done", result["state"])
            @Suppress("UNCHECKED_CAST")
            val reply = result["reply"] as? Map<String, Any?>
            assertNotNull("worker must send a reply", reply)
            assertEquals("pong", reply?.get("type"))
            assertEquals("https://appassets.androidplatform.net", reply?.get("origin"))
            assertEquals(true, reply?.get("isSecureContext"))
        }
    }

    @Test
    fun missingWorkerScriptFailsClosed() {
        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val result = loadPageAndPoll(activity, "worker-probe/missing-worker.html")
            assertEquals("error", result["state"])
            val category = result["category"] as? String
            assertNotNull("error must have a category", category)
            assertTrue(
                "category must indicate script load or constructor failure, got: $category",
                category == "WORKER_SCRIPT_LOAD_FAILURE" || category == "WORKER_CONSTRUCTOR_FAILURE"
            )
        }
    }
}

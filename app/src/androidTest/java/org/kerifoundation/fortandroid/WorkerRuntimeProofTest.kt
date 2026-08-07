package org.kerifoundation.fortandroid

import android.app.Activity
import android.os.Bundle
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
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
    private lateinit var latch: CountDownLatch
    private var probeResult: Map<String, Any?>? = null

    @Before
    fun setUp() {
        latch = CountDownLatch(1)
        probeResult = null
    }

    @After
    fun tearDown() {
        scenario.close()
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun createAssetLoader(activity: WorkerProbeActivity): WebViewAssetLoader {
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(activity)
        // Serve test assets from androidTest context, not app context.
        // androidTest assets are at: app/src/androidTest/assets/
        // WebViewAssetLoader.AssetsPathHandler uses the Activity's assets,
        // which for an instrumentation Activity resolves androidTest/assets/.
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
        val loader = createAssetLoader(activity)
        val url = "https://appassets.androidplatform.net/$pagePath"

        activity.runOnUiThread {
            activity.webView.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: android.webkit.WebResourceRequest
                ): WebResourceResponse? {
                    return loader.shouldInterceptRequest(request.url)
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    // Poll for result
                    view.postDelayed({
                        pollForResult(view)
                    }, 500)
                }
            }
            activity.webView.loadUrl(url)
        }

        assertTrue("timeout waiting for worker result", latch.await(timeoutSeconds, TimeUnit.SECONDS))
        assertNotNull("probe result must not be null", probeResult)
        return probeResult!!
    }

    private fun pollForResult(view: WebView) {
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
                    probeResult = map
                    latch.countDown()
                } else {
                    // Still loading — poll again
                    view.postDelayed({ pollForResult(view) }, 300)
                }
            } catch (_: Exception) {
                view.postDelayed({ pollForResult(view) }, 300)
            }
        }
    }

    // ── Tests ────────────────────────────────────────────────────────────

    @Test
    fun dedicatedWorkerCompletesSameOriginRoundTrip() {
        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)

        scenario.onActivity { activity ->
            // Run the actual test on a background thread so we can block on latch
            Thread {
                try {
                    val result = loadPageAndPoll(activity, "worker-probe/index.html")

                    activity.runOnUiThread {
                        try {
                            assertEquals("done", result["state"])

                            @Suppress("UNCHECKED_CAST")
                            val reply = result["reply"] as? Map<String, Any?>
                            assertNotNull("worker must send a reply", reply)

                            assertEquals(
                                "pong",
                                reply?.get("type"),
                                "worker reply type must be pong"
                            )
                            assertEquals(
                                "https://appassets.androidplatform.net",
                                reply?.get("origin"),
                                "worker origin must be trusted HTTPS origin"
                            )
                            assertEquals(
                                true,
                                reply?.get("isSecureContext"),
                                "worker must report secure context"
                            )
                        } finally {
                            // Ensure latch is counted down even on assertion failure
                            if (latch.count > 0) latch.countDown()
                        }
                    }
                } catch (e: Exception) {
                    probeResult = mapOf("state" to "error", "category" to "PAGE_LOAD_FAILURE", "message" to e.message)
                    latch.countDown()
                }
            }.start()
        }

        assertTrue("test must complete", latch.await(20, TimeUnit.SECONDS))
        assertEquals("done", probeResult?.get("state"))
    }

    @Test
    fun missingWorkerScriptFailsClosed() {
        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)

        scenario.onActivity { activity ->
            Thread {
                try {
                    val result = loadPageAndPoll(activity, "worker-probe/missing-worker.html")

                    activity.runOnUiThread {
                        try {
                            assertEquals("error", result["state"])
                            val category = result["category"] as? String
                            assertNotNull("error must have a category", category)
                            assertTrue(
                                "category must be WORKER_SCRIPT_LOAD_FAILURE, got: $category",
                                category == "WORKER_SCRIPT_LOAD_FAILURE" || category == "WORKER_CONSTRUCTOR_FAILURE"
                            )
                        } finally {
                            if (latch.count > 0) latch.countDown()
                        }
                    }
                } catch (e: Exception) {
                    probeResult = mapOf("state" to "error", "category" to "PAGE_LOAD_FAILURE", "message" to e.message)
                    latch.countDown()
                }
            }.start()
        }

        assertTrue("test must complete", latch.await(20, TimeUnit.SECONDS))
        val state = probeResult?.get("state")
        assertTrue("must be in error state, got: $state", state == "error")
    }
}

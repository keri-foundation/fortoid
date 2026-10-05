package org.kerifoundation.fortandroid

import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
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
        val assetsHandler = WebViewAssetLoader.AssetsPathHandler(context)
        val pathHandler = TestAssetPathHandler(assetsHandler)
        return WebViewAssetLoader.Builder()
            .addPathHandler("/", pathHandler)
            .setDomain("appassets.androidplatform.net")
            .setHttpAllowed(true)
            .build()
    }

    /**
     * Configure the WebView, initiate navigation, and return immediately.
     * The caller waits on [latch] on the instrumentation test thread.
     * WebView callbacks and polling run on the main thread.
     */
    private fun configureAndNavigate(
        activity: WorkerProbeActivity,
        pagePath: String,
        latch: CountDownLatch,
        resultHolder: Array<Map<String, Any?>?>
    ) {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val loader = createAssetLoader(instrCtx)
        val url = "https://appassets.androidplatform.net/$pagePath"

        activity.webView.webViewClient = object : androidx.webkit.WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: android.webkit.WebResourceRequest
            ): WebResourceResponse? {
                return loader.shouldInterceptRequest(request.url)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                view.postDelayed({ pollForResult(view, resultHolder, latch) }, 500)
            }
        }
        activity.webView.loadUrl(url)
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
        val latch = CountDownLatch(1)
        @Suppress("UNCHECKED_CAST")
        val resultHolder = arrayOfNulls<Map<String, Any?>>(1)

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            configureAndNavigate(activity, "worker-probe/index.html", latch, resultHolder)
        }
        // onActivity has returned; wait on the instrumentation test thread
        assertTrue("timeout waiting for worker result", latch.await(15, TimeUnit.SECONDS))
        assertNotNull("probe result must not be null", resultHolder[0])

        val result = resultHolder[0]!!
        assertEquals("done", result["state"])
        val reply = result["reply"] as? org.json.JSONObject
        assertNotNull("worker must send a reply", reply)
        assertEquals("pong", reply?.optString("type"))
        assertEquals("https://appassets.androidplatform.net", reply?.optString("origin"))
        assertEquals(true, reply?.optBoolean("isSecureContext"))
    }

    @Test
    fun missingWorkerScriptFailsClosed() {
        val latch = CountDownLatch(1)
        @Suppress("UNCHECKED_CAST")
        val resultHolder = arrayOfNulls<Map<String, Any?>>(1)

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            configureAndNavigate(activity, "worker-probe/missing-worker.html", latch, resultHolder)
        }
        assertTrue("timeout waiting for negative control", latch.await(15, TimeUnit.SECONDS))
        assertNotNull("probe result must not be null", resultHolder[0])

        val result = resultHolder[0]!!
        assertEquals("error", result["state"])
        val category = result["category"] as? String
        assertNotNull("error must have a category", category)
        assertEquals(
            "category must be WORKER_SCRIPT_LOAD_FAILURE, got: $category",
            "WORKER_SCRIPT_LOAD_FAILURE", category
        )
    }
}

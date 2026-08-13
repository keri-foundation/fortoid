package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Diagnostic that locates where the Android-hosted PyWorker environment diverges
 * from the browser control with respect to pyscript.storage, polyscript.storage,
 * IndexedDB, and PyScript config propagation.
 *
 * This test PASSES when a complete structured diagnostic is captured (state
 * "done"), even when the measured result reports storage as missing. It FAILS
 * only when the diagnostic itself could not run (worker did not boot, result
 * never arrived, or canonical PyScript assets could not load).
 *
 * Evidence classification: ANDROID_PYWORKER_STORAGE_CONTEXT
 */
@RunWith(AndroidJUnit4::class)
class PyodideStorageContextDiagnosticTest {

    companion object {
        private const val TAG = "PyodideStorageContextDiag"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val DIAGNOSTIC_TIMEOUT_MS = 240_000L
    }

    private lateinit var scenario: ActivityScenario<WorkerProbeActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    @Test
    fun pyworkerStorageContextDiagnosticCompletes() {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val targetCtx = InstrumentationRegistry.getInstrumentation().targetContext

        val lastResult = AtomicReference<String>()
        val deadline = SystemClock.elapsedRealtime() + DIAGNOSTIC_TIMEOUT_MS

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val wv = activity.webView

            val probeHandler = PrefixingTestAssetPathHandler(
                WebViewAssetLoader.AssetsPathHandler(instrCtx),
                "android-pyworker-storage-context-probe/"
            )
            val payloadHandler = MainActivity.PayloadRootPathHandler(
                WebViewAssetLoader.AssetsPathHandler(targetCtx)
            )

            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/android-pyworker-storage-context-probe/", probeHandler)
                .addPathHandler("/android/", WebViewAssetLoader.AssetsPathHandler(targetCtx))
                .addPathHandler("/", payloadHandler)
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true)
                .build()

            wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val url = request.url.toString()
                    if (request.isForMainFrame) {
                        val response = loader.shouldInterceptRequest(request.url)
                        Log.i(TAG, "STAGE=MAIN_RESOURCE_INTERCEPTED url=$url intercepted=${response != null}")
                        return response
                    }

                    val localUri = WebRequestPolicy.mapPyodideCdnToLocal(request.url)
                    if (localUri != null) {
                        Log.i(TAG, "STAGE=PYODIDE_CDN_REDIRECT from=$url to=$localUri")
                        val response = loader.shouldInterceptRequest(localUri)
                        if (response != null) {
                            val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
                            headers["Access-Control-Allow-Origin"] = "*"
                            headers["Cross-Origin-Resource-Policy"] = "cross-origin"
                            response.responseHeaders = headers
                            return response
                        }
                        Log.e(TAG, "STAGE=PYODIDE_LOCAL_MISSING mapped=$localUri")
                        return createBlockedResponse()
                    }

                    if (request.url.host != "appassets.androidplatform.net") {
                        Log.w(TAG, "STAGE=BLOCKED_EXTERNAL url=$url")
                        return createBlockedResponse()
                    }

                    return loader.shouldInterceptRequest(request.url)
                }

                private fun createBlockedResponse(): WebResourceResponse {
                    return WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0))).apply {
                        setStatusCodeAndReasonPhrase(403, "Forbidden")
                        responseHeaders = mapOf("Cache-Control" to "no-store")
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: androidx.webkit.WebResourceErrorCompat) {
                    Log.e(TAG, "STAGE=RECEIVED_ERROR mainFrame=${request.isForMainFrame} url=${request.url} code=${error.errorCode}")
                }
            }

            val contractStream = targetCtx.assets.open("android/runtime-origin-contract.json")
            val contractBytes = contractStream.readBytes()
            contractStream.close()
            val contractJson = String(contractBytes, Charsets.UTF_8)
            WebViewCompat.addDocumentStartJavaScript(wv, "window.__FORT_RUNTIME_ORIGIN__ = $contractJson;", setOf(TRUSTED_ORIGIN))

            Log.i(TAG, "STAGE=NAVIGATION_REQUESTED")
            wv.loadUrl("$TRUSTED_ORIGIN/android-pyworker-storage-context-probe/index.html")
        }

        // Poll the page global for a terminal diagnostic state.
        while (SystemClock.elapsedRealtime() < deadline) {
            val latch = CountDownLatch(1)
            val sample = AtomicReference<String>()
            scenario.onActivity { activity ->
                activity.webView.evaluateJavascript(
                    "JSON.stringify(window.__FORT_PYWORKER_STORAGE_DIAGNOSTIC__ || {state:'loading'})"
                ) { raw ->
                    sample.set(raw)
                    latch.countDown()
                }
            }
            if (!latch.await(5, TimeUnit.SECONDS)) continue

            val raw = sample.get() ?: continue
            val state = parseState(raw)
            if (state == "done" || state == "error") {
                lastResult.set(raw)
                break
            }
            SystemClock.sleep(1000)
        }

        val result = lastResult.get()
        if (result == null) {
            fail("PyWorker storage-context diagnostic never reached a terminal state")
        }

        Log.i(TAG, "DIAGNOSTIC_RESULT $result")

        val state = parseState(result)
        assertTrue(
            "diagnostic did not complete (state=$state): $result",
            state == "done"
        )
    }

    private fun parseState(raw: String?): String {
        if (raw == null) return "loading"
        val trimmed = raw.trim()
        if (!trimmed.startsWith("{")) return "loading"
        return try {
            org.json.JSONObject(trimmed).optString("state", "loading")
        } catch (_: Exception) {
            "loading"
        }
    }
}

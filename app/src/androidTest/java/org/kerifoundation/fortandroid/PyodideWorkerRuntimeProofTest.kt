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
import androidx.webkit.WebMessageCompat
import androidx.webkit.JavaScriptReplyProxy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.kerifoundation.fort.bridge.BridgeContract
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Behavioral proof that the real FortWeb PyScript/Pyodide worker runtime
 * boots, preloads, and handles a real producer request on Android API 36.
 *
 * Uses WorkerProbeActivity (target process, debug-only).
 * Routes both androidTest probe assets and target payload assets through
 * a composite WebViewAssetLoader under the trusted origin.
 *
 * Observes producer lifecycle independently via the native bridge contract.
 *
 * Evidence classification: FORTWEB-PYODIDE-WORKER
 */
@RunWith(AndroidJUnit4::class)
class PyodideWorkerRuntimeProofTest {

    companion object {
        private const val TAG = "PyodideWorkerProof"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val PYODIDE_TIMEOUT_MS = 210_000L
        private const val PROBE_INIT_TIMEOUT_MS = 15_000L
    }

    private lateinit var scenario: ActivityScenario<WorkerProbeActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    data class WorkerObservation(
        val state: String,
        val stage: String,
        val origin: String,
        val isSecureContext: Boolean,
        val storageBackend: String?,
        val keyAlgorithm: String?,
        val keyTier: String?,
        val category: String?,
        val message: String?
    )

    data class NativeEvent(
        val type: String,
        val state: String?,
        val message: String?
    )

    @Test
    fun producerWorkerBootsAndRespondsToSettingsRequest() {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val targetCtx = InstrumentationRegistry.getInstrumentation().targetContext

        val lastObservation = AtomicReference<WorkerObservation>()
        val preloadComplete = AtomicBoolean(false)
        val preloadFailed = AtomicBoolean(false)
        val preloadFailedReason = AtomicReference<String>()
        val mainResourceError = AtomicReference<String>()
        val pageFinishedAtMs = java.util.concurrent.atomic.AtomicLong(0L)

        // Native bridge listener for producer diagnostics
        val nativeEvents = mutableListOf<NativeEvent>()

        val deadline = SystemClock.elapsedRealtime() + PYODIDE_TIMEOUT_MS

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val wv = activity.webView

            // Prefix-aware probe handler — WebViewAssetLoader strips the prefix
            val probeHandler = PrefixingTestAssetPathHandler(
                WebViewAssetLoader.AssetsPathHandler(instrCtx),
                "android-pyodide-worker-probe/"
            )
            val payloadHandler = MainActivity.PayloadRootPathHandler(
                WebViewAssetLoader.AssetsPathHandler(targetCtx)
            )

            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/android-pyodide-worker-probe/", probeHandler)
                .addPathHandler("/android/", WebViewAssetLoader.AssetsPathHandler(targetCtx))
                .addPathHandler("/", payloadHandler)
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true)
                .build()

            // ── Native bridge listener for producer diagnostics ──────
            WebViewCompat.addWebMessageListener(wv, BridgeContract.HANDLER_NAME, setOf(TRUSTED_ORIGIN),
                object : WebViewCompat.WebMessageListener {
                    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: android.net.Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                        if (!isMainFrame) return
                        val rawPayload = message.data ?: return
                        val bounded: String = if (rawPayload.length > 4096) rawPayload.substring(0, 4096) else rawPayload
                try {
                    val obj = org.json.JSONObject(bounded)
                    val type: String = obj.getString("type")
                    val msg: String = obj.getString("message")
                    Log.i(TAG, "NATIVE_EVENT type=$type msg=${msg.take(200)}")
                    synchronized(nativeEvents) {
                        nativeEvents.add(NativeEvent(type, if (obj.has("state")) obj.getString("state") else null, msg))
                    }
                    if (msg.contains("worker_preload_complete")) {
                        preloadComplete.set(true)
                        Log.i(TAG, "STAGE=PRELOAD_COMPLETE")
                    }
                    if (msg.contains("worker_preload_failed")) {
                        preloadFailed.set(true)
                        preloadFailedReason.set(msg)
                        Log.e(TAG, "STAGE=PRELOAD_FAILED reason=$msg")
                    }
                } catch (_: Exception) { /* skip unparseable */ }
                    }
                }
            )

            wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val url = request.url.toString()
                    if (request.isForMainFrame) {
                        val response = loader.shouldInterceptRequest(request.url)
                        Log.i(TAG, "STAGE=MAIN_RESOURCE_INTERCEPTED url=$url intercepted=${response != null}")
                        return response
                    }

                    // CDN→local Pyodide redirect (same policy as production MainActivity)
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

                    // Block external requests (offline runtime)
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

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    Log.i(TAG, "STAGE=PAGE_STARTED url=$url")
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    Log.i(TAG, "STAGE=PAGE_FINISHED url=$url")
                    pageFinishedAtMs.compareAndSet(0L, SystemClock.elapsedRealtime())
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: androidx.webkit.WebResourceErrorCompat) {
                    Log.e(TAG, "STAGE=RECEIVED_ERROR mainFrame=${request.isForMainFrame} url=${request.url} code=${error.errorCode}")
                    if (request.isForMainFrame) {
                        mainResourceError.set("code=${error.errorCode} desc=${error.description}")
                    }
                }
            }

            // Inject the runtime-origin contract before navigation
            val contractStream = targetCtx.assets.open("android/runtime-origin-contract.json")
            val contractBytes = contractStream.readBytes()
            contractStream.close()
            val contractJson = String(contractBytes, Charsets.UTF_8)

            WebViewCompat.addDocumentStartJavaScript(wv, "window.__FORT_RUNTIME_ORIGIN__ = $contractJson;", setOf(TRUSTED_ORIGIN))

            Log.i(TAG, "STAGE=NAVIGATION_REQUESTED")
            wv.loadUrl("$TRUSTED_ORIGIN/android-pyodide-worker-probe/index.html")
        }

        // ── Polling loop ────────────────────────────────────────────

        while (SystemClock.elapsedRealtime() < deadline) {
            // Fail fast on main resource error
            val mre = mainResourceError.get()
            if (mre != null) fail("Main resource error: $mre")

            // Fail fast on preload failure
            if (preloadFailed.get()) {
                fail("Worker preload failed: ${preloadFailedReason.get()}")
            }

            val sampleLatch = CountDownLatch(1)
            val sample = AtomicReference<WorkerObservation>()

            scenario.onActivity { activity ->
                activity.webView.evaluateJavascript(
                    "JSON.stringify(window.__pyodideWorkerResult || {state:'loading'})"
                ) { raw ->
                    sample.set(parseWorkerResult(raw))
                    sampleLatch.countDown()
                }
            }

            sampleLatch.await(3000, TimeUnit.MILLISECONDS)
            val obs = sample.get() ?: continue
            lastObservation.set(obs)

            // Fail fast if probe page loaded but script never initialized
            val finishedAt = pageFinishedAtMs.get()
            if (finishedAt > 0L &&
                SystemClock.elapsedRealtime() - finishedAt >= PROBE_INIT_TIMEOUT_MS &&
                obs.stage == "unknown" && obs.state == "loading") {
                fail("PROBE_SCRIPT_NOT_INITIALIZED: page loaded but probe global never appeared")
            }

            if (obs.state == "error") {
                fail("Worker proof failed: category=${obs.category} message=${obs.message} stage=${obs.stage}")
            }

            if (obs.state == "done") {
                // Require native preload evidence independently
                if (!preloadComplete.get()) {
                    fail("Probe reported done but preload_complete not observed via native bridge")
                }

                assertEquals("must be trusted origin", TRUSTED_ORIGIN, obs.origin)
                assertTrue("must be secure context", obs.isSecureContext)
                assertEquals("storageBackend", "Browser IndexedDB via WebBaser and WebKeeper", obs.storageBackend)
                assertEquals("keyAlgorithm", "salty", obs.keyAlgorithm)
                assertEquals("keyTier", "low", obs.keyTier)
                Log.i(TAG, "STAGE=READY")
                return
            }

            Thread.sleep(2000)
        }

        val latest = lastObservation.get()
        fail("Pyodide worker proof timed out. stage=${latest?.stage} state=${latest?.state}")
    }

    private fun parseWorkerResult(raw: String?): WorkerObservation {
        if (raw == null) return WorkerObservation("loading", "no_response", "", false, null, null, null, null, null)
        val unquoted = raw.trim()
            .removeSurrounding("\"")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
        return try {
            val obj = org.json.JSONObject(unquoted)
            WorkerObservation(
                state = obj.optString("state", "loading"),
                stage = obj.optString("stage", "unknown"),
                origin = obj.optString("origin", ""),
                isSecureContext = obj.optBoolean("isSecureContext", false),
                storageBackend = obj.optString("storageBackend", "").takeIf { it.isNotEmpty() },
                keyAlgorithm = obj.optString("keyAlgorithm", "").takeIf { it.isNotEmpty() },
                keyTier = obj.optString("keyTier", "").takeIf { it.isNotEmpty() },
                category = obj.optString("category", "").takeIf { it.isNotEmpty() },
                message = obj.optString("message", "").takeIf { it.isNotEmpty() }
            )
        } catch (_: Exception) {
            WorkerObservation("loading", "parse_error", "", false, null, null, null, null, null)
        }
    }
}

/**
 * PathHandler that re-adds the asset prefix stripped by WebViewAssetLoader.
 *
 * WebViewAssetLoader strips the registered URL prefix before calling the
 * handler, so a request for /prefix/index.html reaches us as "index.html".
 * This wrapper prepends the asset directory prefix so the underlying
 * AssetsPathHandler can find the file at prefix/index.html.
 */
class PrefixingTestAssetPathHandler(
    private val delegate: WebViewAssetLoader.PathHandler,
    private val assetPrefix: String
) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val response = delegate.handle(assetPrefix + path) ?: return null
        // Apply production-equivalent COOP/COEP/CORP headers
        val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.responseHeaders = headers
        return response
    }
}

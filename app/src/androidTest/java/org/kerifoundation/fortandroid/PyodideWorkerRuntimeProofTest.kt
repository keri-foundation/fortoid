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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Behavioral proof that the real FortWeb PyScript/Pyodide worker runtime
 * boots, preloads, and handles a real producer request on Android API 36.
 *
 * Uses WorkerProbeActivity (target process, debug-only).
 * Routes both androidTest probe assets and target payload assets through
 * a composite WebViewAssetLoader under the trusted origin.
 *
 * Evidence classification: FORTWEB-PYODIDE-WORKER
 */
@RunWith(AndroidJUnit4::class)
class PyodideWorkerRuntimeProofTest {

    companion object {
        private const val TAG = "PyodideWorkerProof"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val TIMEOUT_MS = 210_000L // 3.5 min for Pyodide boot + preload
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
        val preloadComplete: Boolean,
        val storageBackend: String?,
        val keyAlgorithm: String?,
        val keyTier: String?,
        val category: String?,
        val message: String?
    )

    @Test
    fun producerWorkerBootsAndRespondsToSettingsRequest() {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val targetCtx = InstrumentationRegistry.getInstrumentation().targetContext
        val lastObservation = AtomicReference<WorkerObservation>()

        val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val wv = activity.webView

            // Composite loader: probe assets from androidTest, payload from target app
            val probeHandler = TestAssetPathHandler(
                WebViewAssetLoader.AssetsPathHandler(instrCtx)
            )
            val payloadHandler = MainActivity.PayloadRootPathHandler(
                WebViewAssetLoader.AssetsPathHandler(targetCtx)
            )

            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/android-pyodide-worker-probe/", probeHandler)
                .addPathHandler("/android/", object : WebViewAssetLoader.PathHandler {
                    override fun handle(path: String): WebResourceResponse? {
                        return WebViewAssetLoader.AssetsPathHandler(targetCtx).handle(path)
                    }
                })
                .addPathHandler("/", payloadHandler)
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true)
                .build()

            wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? {
                    return loader.shouldInterceptRequest(request.url)
                }
            }

            // Inject the runtime-origin contract before navigation
            val contractStream = targetCtx.assets.open("android/runtime-origin-contract.json")
            val contractBytes = contractStream.readBytes()
            contractStream.close()
            val contractJson = String(contractBytes, Charsets.UTF_8)

            androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
                wv,
                "window.__FORT_RUNTIME_ORIGIN__ = $contractJson;",
                setOf(TRUSTED_ORIGIN)
            )

            wv.loadUrl("$TRUSTED_ORIGIN/android-pyodide-worker-probe/index.html")
        }

        // Poll for result on the test thread
        while (SystemClock.elapsedRealtime() < deadline) {
            val sampleLatch = CountDownLatch(1)
            val sample = AtomicReference<WorkerObservation>()

            scenario.onActivity { activity ->
                val wv = activity.webView
                wv.evaluateJavascript(
                    "JSON.stringify(window.__pyodideWorkerResult || {state:'loading'})"
                ) { raw ->
                    val obs = parseWorkerResult(raw)
                    sample.set(obs)
                    if (obs.state == "done" || obs.state == "error") {
                        Log.i(TAG, "STAGE=${obs.state} stage=${obs.stage}")
                    }
                    sampleLatch.countDown()
                }
            }

            sampleLatch.await(3000, TimeUnit.MILLISECONDS)
            val obs = sample.get() ?: continue
            lastObservation.set(obs)

            if (obs.state == "done") {
                // All assertions against one coherent observation
                assertEquals("must be trusted origin", TRUSTED_ORIGIN, obs.origin)
                assertTrue("must be secure context", obs.isSecureContext)
                assertTrue("preload must be complete", obs.preloadComplete)
                assertNotNull("storageBackend must be present", obs.storageBackend)
                assertNotNull("keyAlgorithm must be present", obs.keyAlgorithm)
                assertNotNull("keyTier must be present", obs.keyTier)
                Log.i(TAG, "STAGE=READY storage=$obs.storageBackend algo=$obs.keyAlgorithm tier=$obs.keyTier")
                return
            }

            if (obs.state == "error") {
                fail("Worker proof failed: category=${obs.category} message=${obs.message} stage=${obs.stage}")
            }

            Thread.sleep(2000)
        }

        val latest = lastObservation.get()
        fail("Pyodide worker proof timed out. stage=${latest?.stage} state=${latest?.state}")
    }

    private fun parseWorkerResult(raw: String?): WorkerObservation {
        if (raw == null) return WorkerObservation("loading", "no_response", "", false, false, null, null, null, null, null)
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
                preloadComplete = obj.optBoolean("preloadComplete", false),
                storageBackend = obj.optString("storageBackend", "").takeIf { it.isNotEmpty() },
                keyAlgorithm = obj.optString("keyAlgorithm", "").takeIf { it.isNotEmpty() },
                keyTier = obj.optString("keyTier", "").takeIf { it.isNotEmpty() },
                category = obj.optString("category", "").takeIf { it.isNotEmpty() },
                message = obj.optString("message", "").takeIf { it.isNotEmpty() }
            )
        } catch (_: Exception) {
            WorkerObservation("loading", "parse_error", "", false, false, null, null, null, null, null)
        }
    }
}

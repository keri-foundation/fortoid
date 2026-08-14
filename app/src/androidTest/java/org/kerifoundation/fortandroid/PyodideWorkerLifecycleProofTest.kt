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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.kerifoundation.fort.bridge.BridgeContract
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Behavioral proof that a real FortWeb/KERI-v2 vault created through one
 * Android-hosted Pyodide worker remains discoverable and reopenable after that
 * worker is terminated and replaced by a genuinely new worker.
 *
 * Sequence: bridge #1 → vaults.create → vaults.list → bridge1.destroy()
 * (observe underlying Worker terminate) → bridge #2 (observe new Worker
 * construct) → vaults.list → vaults.open → vaults.summary → vaults.close.
 *
 * Worker construction/termination is observed through a test-only Worker
 * constructor wrapper installed by the probe before importing bridge.js.
 *
 * Evidence classification: FORTWEB-PYODIDE-VAULT-LIFECYCLE
 */
@RunWith(AndroidJUnit4::class)
class PyodideWorkerLifecycleProofTest {

    companion object {
        private const val TAG = "PyodideLifecycleProof"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val LIFECYCLE_TIMEOUT_MS = 360_000L
        private const val PROBE_INIT_TIMEOUT_MS = 20_000L
    }

    private lateinit var scenario: ActivityScenario<WorkerProbeActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    data class LifecycleObservation(
        val state: String,
        val stage: String,
        val vaultId: String?,
        val vaultAlias: String?,
        val worker1Id: Int,
        val worker2Id: Int,
        val worker1Terminated: Boolean,
        val worker2Distinct: Boolean,
        val worker2Untainted: Boolean,
        val constructAfterPhase1: Int,
        val terminateAfterPhase1: Int,
        val constructAfterPhase2: Int,
        val phase2VaultFound: Boolean,
        val reopenedVaultId: String?,
        val summaryVerified: Boolean,
        val origin: String,
        val isSecureContext: Boolean,
        val category: String?,
        val message: String?
    )

    @Test
    fun vaultSurvivesWorkerTerminationAndReopensInNewWorker() {
        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val targetCtx = InstrumentationRegistry.getInstrumentation().targetContext

        val lastObservation = AtomicReference<LifecycleObservation>()
        val pageFinishedAtMs = AtomicLong(0L)

        // Native bridge diagnostics: only explicit producer failures are fail-fast.
        val preloadFailed = AtomicBoolean(false)
        val preloadFailedReason = AtomicReference<String>()
        val terminalFailure = AtomicBoolean(false)
        val terminalFailureReason = AtomicReference<String>()

        val deadline = SystemClock.elapsedRealtime() + LIFECYCLE_TIMEOUT_MS

        scenario = ActivityScenario.launch(WorkerProbeActivity::class.java)
        scenario.onActivity { activity ->
            val wv = activity.webView

            val probeHandler = PrefixingTestAssetPathHandler(
                WebViewAssetLoader.AssetsPathHandler(instrCtx),
                "android-pyodide-worker-lifecycle-probe/"
            )
            val payloadHandler = MainActivity.PayloadRootPathHandler(
                WebViewAssetLoader.AssetsPathHandler(targetCtx)
            )

            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/android-pyodide-worker-lifecycle-probe/", probeHandler)
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
                            val type: String = obj.optString("type")
                            val msg: String = obj.optString("message")
                            Log.i(TAG, "NATIVE_EVENT type=$type msg=${msg.take(160)}")
                            when {
                                msg.contains("worker_preload_failed") -> {
                                    preloadFailed.set(true)
                                    preloadFailedReason.set(msg)
                                }
                                msg.contains("terminal_failure") -> {
                                    terminalFailure.set(true)
                                    terminalFailureReason.set(msg)
                                }
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

                override fun onPageFinished(view: WebView, url: String?) {
                    Log.i(TAG, "STAGE=PAGE_FINISHED url=$url")
                    pageFinishedAtMs.compareAndSet(0L, SystemClock.elapsedRealtime())
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: androidx.webkit.WebResourceErrorCompat) {
                    Log.e(TAG, "STAGE=RECEIVED_ERROR mainFrame=${request.isForMainFrame} url=${request.url} code=${error.errorCode}")
                }
            }

            // Inject the runtime-origin contract before navigation.
            val contractStream = targetCtx.assets.open("android/runtime-origin-contract.json")
            val contractBytes = contractStream.readBytes()
            contractStream.close()
            val contractJson = String(contractBytes, Charsets.UTF_8)
            WebViewCompat.addDocumentStartJavaScript(wv, "window.__FORT_RUNTIME_ORIGIN__ = $contractJson;", setOf(TRUSTED_ORIGIN))

            Log.i(TAG, "STAGE=NAVIGATION_REQUESTED")
            wv.loadUrl("$TRUSTED_ORIGIN/android-pyodide-worker-lifecycle-probe/index.html")
        }

        // ── Polling loop ────────────────────────────────────────────
        while (SystemClock.elapsedRealtime() < deadline) {
            if (preloadFailed.get()) {
                fail("Worker preload failed: ${preloadFailedReason.get()}")
            }
            if (terminalFailure.get()) {
                fail("Terminal producer failure: ${terminalFailureReason.get()}")
            }

            val sampleLatch = CountDownLatch(1)
            val sample = AtomicReference<LifecycleObservation>()
            scenario.onActivity { activity ->
                activity.webView.evaluateJavascript(
                    "window.__vaultLifecycleResult"
                ) { raw ->
                    sample.set(parseObservation(raw))
                    sampleLatch.countDown()
                }
            }

            sampleLatch.await(3000, TimeUnit.MILLISECONDS)
            val obs = sample.get() ?: continue
            lastObservation.set(obs)

            val finishedAt = pageFinishedAtMs.get()
            if (finishedAt > 0L &&
                SystemClock.elapsedRealtime() - finishedAt >= PROBE_INIT_TIMEOUT_MS &&
                obs.stage == "unknown" && obs.state == "loading") {
                fail("PROBE_SCRIPT_NOT_INITIALIZED: page loaded but probe global never appeared")
            }

            if (obs.state == "error") {
                fail("Vault lifecycle proof failed: category=${obs.category} message=${obs.message} stage=${obs.stage}")
            }

            if (obs.state == "done") {
                assertLifecycle(obs)
                Log.i(TAG, "STAGE=READY")
                return
            }

            Thread.sleep(2000)
        }

        val latest = lastObservation.get()
        fail("Vault lifecycle proof timed out. stage=${latest?.stage} state=${latest?.state}")
    }

    private fun assertLifecycle(obs: LifecycleObservation) {
        assertEquals("must be trusted origin", TRUSTED_ORIGIN, obs.origin)
        assertTrue("must be secure context", obs.isSecureContext)

        // Behavioral evidence of first-worker usability: a successful real
        // vaults.create through bridge1 proves the bridge obtained a usable
        // Worker and crossed its preload gate.
        assertTrue("first Worker must be constructed", obs.constructAfterPhase1 >= 1)

        // Underlying Worker termination was independently observed.
        assertTrue("underlying Worker terminate must be observed", obs.terminateAfterPhase1 >= 1)
        assertTrue("first worker id must be present in terminated ids", obs.worker1Terminated)

        // A genuinely new Worker was constructed after termination.
        assertTrue(
            "second Worker must be constructed after termination (${obs.constructAfterPhase2} > ${obs.constructAfterPhase1})",
            obs.constructAfterPhase2 > obs.constructAfterPhase1
        )
        assertTrue(
            "second worker id must be distinct from first (${obs.worker2Id} > ${obs.worker1Id})",
            obs.worker2Distinct
        )
        assertTrue("second worker id must not be terminated before cleanup", obs.worker2Untainted)

        // Behavioral evidence of second-worker usability: the same persisted
        // vault was rediscovered through bridge2, then reopened and summarized.
        assertTrue("created vault must persist across worker termination", obs.phase2VaultFound)
        assertEquals("reopened vault id must match created id", obs.vaultId, obs.reopenedVaultId)
        assertTrue("vaults.summary must confirm reopened vault", obs.summaryVerified)

        Log.i(
            TAG,
            "STAGE=PROVEN vaultId=${obs.vaultId} workers=[${obs.worker1Id},${obs.worker2Id}] " +
                "terminates=${obs.terminateAfterPhase1}"
        )
    }

    private fun parseObservation(raw: String?): LifecycleObservation {
        val trimmed = raw?.trim()
        if (trimmed.isNullOrEmpty() || trimmed == "null" || trimmed == "undefined") {
            return LifecycleObservation("loading", "no_response", null, null, 0, 0, false, false, false, 0, 0, 0, false, null, false, "", false, null, null)
        }
        return try {
            val obj = org.json.JSONObject(trimmed)
            LifecycleObservation(
                state = obj.optString("state", "loading"),
                stage = obj.optString("stage", "unknown"),
                vaultId = obj.optString("vaultId", "").takeIf { it.isNotEmpty() },
                vaultAlias = obj.optString("vaultAlias", "").takeIf { it.isNotEmpty() },
                worker1Id = obj.optInt("worker1Id", 0),
                worker2Id = obj.optInt("worker2Id", 0),
                worker1Terminated = obj.optBoolean("worker1Terminated", false),
                worker2Distinct = obj.optBoolean("worker2Distinct", false),
                worker2Untainted = obj.optBoolean("worker2Untainted", false),
                constructAfterPhase1 = obj.optInt("constructAfterPhase1", 0),
                terminateAfterPhase1 = obj.optInt("terminateAfterPhase1", 0),
                constructAfterPhase2 = obj.optInt("constructAfterPhase2", 0),
                phase2VaultFound = obj.optBoolean("phase2VaultFound", false),
                reopenedVaultId = obj.optString("reopenedVaultId", "").takeIf { it.isNotEmpty() },
                summaryVerified = obj.optBoolean("summaryVerified", false),
                origin = obj.optString("origin", ""),
                isSecureContext = obj.optBoolean("isSecureContext", false),
                category = obj.optString("category", "").takeIf { it.isNotEmpty() },
                message = obj.optString("message", "").takeIf { it.isNotEmpty() }
            )
        } catch (_: Exception) {
            LifecycleObservation("loading", "parse_error", null, null, 0, 0, false, false, false, 0, 0, 0, false, null, false, "", false, null, null)
        }
    }
}

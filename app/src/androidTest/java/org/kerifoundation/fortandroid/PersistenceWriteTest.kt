package org.kerifoundation.fortandroid

import android.net.Uri
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Phase A: Writes key/value to IndexedDB. Emits WRITE_PID via instrumentation Bundle. */
@RunWith(AndroidJUnit4::class)
class PersistenceWriteTest {

    companion object {
        private const val TAG = "FortAndroidPersist"
    }

    @Test
    fun writeValueToIndexedDB() {
        val args = InstrumentationRegistry.getArguments()
        val key = args.getString("persistenceKey") ?: error("persistenceKey required")
        val value = args.getString("persistenceValue") ?: error("persistenceValue required")

        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val latch = CountDownLatch(1)
        var output = ""
        val pollingStarted = AtomicBoolean(false)
        val lastNativeStage = AtomicReference("WEBVIEW_NOT_CREATED")
        val lastProbeState = AtomicReference("(not polled)")
        val targetPid = AtomicInteger(0)

        Log.i(TAG, "STAGE=TEST_STARTED key=$key")

        ActivityScenario.launch(PersistenceProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                targetPid.compareAndSet(0, android.os.Process.myPid())
                val wv = activity.webView
                Log.i(TAG, "STAGE=WEBVIEW_OBTAINED")
                lastNativeStage.set("WEBVIEW_OBTAINED")

                val loader = WebViewAssetLoader.Builder()
                    .addPathHandler("/", TestAssetPathHandler(WebViewAssetLoader.AssetsPathHandler(instrCtx)))
                    .setDomain("appassets.androidplatform.net")
                    .setHttpAllowed(true).build()

                val finalUrl = Uri.parse("https://appassets.androidplatform.net/persistence-probe/write.html")
                    .buildUpon()
                    .appendQueryParameter("key", key)
                    .appendQueryParameter("value", value)
                    .build()
                    .toString()

                wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                    override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
                        val url = r.url.toString()
                        val isMain = r.isForMainFrame
                        val response = loader.shouldInterceptRequest(r.url)
                        if (isMain) {
                            val intercepted = response != null
                            Log.i(TAG, "STAGE=MAIN_RESOURCE_INTERCEPTED url=$url intercepted=$intercepted")
                            lastNativeStage.set(
                                if (intercepted) "MAIN_RESOURCE_INTERCEPTED"
                                else "MAIN_RESOURCE_NOT_INTERCEPTED"
                            )
                        }
                        return response
                    }

                    override fun onPageStarted(v: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                        Log.i(TAG, "STAGE=PAGE_STARTED url=$url")
                        lastNativeStage.set("PAGE_STARTED")
                    }

                    override fun onPageFinished(v: WebView, url: String?) {
                        Log.i(TAG, "STAGE=PAGE_FINISHED url=$url")
                        lastNativeStage.set("PAGE_FINISHED")
                        if (pollingStarted.compareAndSet(false, true)) {
                            Log.i(TAG, "STAGE=POLLING_STARTED")
                            lastNativeStage.set("POLLING_STARTED")
                            poll(v, latch, lastNativeStage, lastProbeState) { r -> output = r }
                        }
                    }

                    override fun onReceivedError(
                        v: WebView, request: WebResourceRequest, error: WebResourceErrorCompat
                    ) {
                        val isMain = request.isForMainFrame
                        Log.e(TAG, "STAGE=RECEIVED_ERROR mainFrame=$isMain url=${request.url} code=${error.errorCode} desc=${error.description}")
                        if (isMain) {
                            lastNativeStage.set("RECEIVED_ERROR:${error.errorCode}")
                        }
                    }

                    override fun onReceivedHttpError(
                        v: WebView, request: WebResourceRequest, response: WebResourceResponse
                    ) {
                        val isMain = request.isForMainFrame
                        Log.e(TAG, "STAGE=RECEIVED_HTTP_ERROR mainFrame=$isMain url=${request.url} status=${response.statusCode}")
                        if (isMain) {
                            lastNativeStage.set("RECEIVED_HTTP_ERROR:${response.statusCode}")
                        }
                    }
                }

                Log.i(TAG, "STAGE=NAVIGATION_REQUESTED url=$finalUrl")
                lastNativeStage.set("NAVIGATION_REQUESTED")
                wv.loadUrl(finalUrl)
            }
            // onActivity has returned; wait on the instrumentation test thread

            val timedOut = !latch.await(20, TimeUnit.SECONDS)
            if (timedOut) {
                val native = lastNativeStage.get()
                val probe = lastProbeState.get()
                Log.e(TAG, "STAGE=TIMEOUT lastNativeStage=$native lastProbeState=$probe")
                assertTrue(
                    "write timed out — last native stage: $native, last probe state: $probe",
                    false
                )
            }

            assertTrue("write must succeed: $output", output.contains("\"state\":\"done\""))
            assertTrue("origin must be https://appassets.androidplatform.net: $output",
                output.contains("\"origin\":\"https://appassets.androidplatform.net\""))
            assertTrue("isSecureContext must be true: $output",
                output.contains("\"isSecureContext\":true"))
            assertTrue("write must confirm immediate readback: $output",
                output.contains("\"immediateReadback\":\"ok\""))

            Log.i(TAG, "STAGE=WRITE_COMPLETE")
            val pid = targetPid.get()
            assertTrue("WRITE_PID must be positive, got: $pid", pid > 0)
            val resultBundle = android.os.Bundle()
            resultBundle.putString("WRITE_PID", pid.toString())
            InstrumentationRegistry.getInstrumentation().sendStatus(0, resultBundle)
        }
    }

    private fun poll(
        v: WebView, l: CountDownLatch,
        nativeStage: AtomicReference<String>,
        probeState: AtomicReference<String>,
        done: (String) -> Unit
    ) {
        v.evaluateJavascript("JSON.stringify(window.__probeResult||{state:'unknown'})") { j ->
            val t = j?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try {
                val obj = org.json.JSONObject(t)
                val state = obj.optString("state", "unknown")
                val stage = obj.optString("stage", "")
                probeState.set("state=$state stage=$stage")
                Log.d(TAG, "STAGE=JAVASCRIPT_RESPONDED state=$state stage=$stage")
                if (state == "done" || state == "error") {
                    Log.i(TAG, "STAGE=PROBE_TERMINAL state=$state")
                    nativeStage.set(if (state == "done") "PROBE_DONE" else "PROBE_ERROR")
                    done(t)
                    l.countDown()
                } else {
                    v.postDelayed({ poll(v, l, nativeStage, probeState, done) }, 300)
                }
            } catch (_: Exception) {
                v.postDelayed({ poll(v, l, nativeStage, probeState, done) }, 300)
            }
        }
    }
}

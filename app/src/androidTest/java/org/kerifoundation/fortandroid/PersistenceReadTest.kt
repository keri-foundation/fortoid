package org.kerifoundation.fortandroid

import android.net.Uri
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Phase B: Reads persisted key/value from IndexedDB after force-stop. Emits READ_PID via instrumentation Bundle. */
@RunWith(AndroidJUnit4::class)
class PersistenceReadTest {
    @Test
    fun readValueFromIndexedDB() {
        val args = InstrumentationRegistry.getArguments()
        val key = args.getString("persistenceKey") ?: error("persistenceKey required")
        val expectedValue = args.getString("persistenceValue") ?: error("persistenceValue required")
        val pid = android.os.Process.myPid()

        val resultBundle = android.os.Bundle()
        resultBundle.putString("READ_PID", pid.toString())

        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val latch = CountDownLatch(1)
        var output = ""
        val pollingStarted = AtomicBoolean(false)

        ActivityScenario.launch(PersistenceProbeActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val wv = activity.webView

                val loader = WebViewAssetLoader.Builder()
                    .addPathHandler("/", TestAssetPathHandler(WebViewAssetLoader.AssetsPathHandler(instrCtx)))
                    .setDomain("appassets.androidplatform.net")
                    .setHttpAllowed(true).build()

                val finalUrl = Uri.parse("https://appassets.androidplatform.net/persistence-probe/read.html")
                    .buildUpon()
                    .appendQueryParameter("key", key)
                    .appendQueryParameter("value", expectedValue)
                    .build()
                    .toString()

                wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                    override fun shouldInterceptRequest(v: WebView, r: android.webkit.WebResourceRequest) =
                        loader.shouldInterceptRequest(r.url)
                    override fun onPageFinished(v: WebView, url: String?) {
                        if (pollingStarted.compareAndSet(false, true)) {
                            poll(v, latch) { r -> output = r }
                        }
                    }
                }
                wv.loadUrl(finalUrl)
            }
            // onActivity has returned; wait on the instrumentation test thread

            assertTrue("read timed out", latch.await(20, TimeUnit.SECONDS))
            assertTrue("read must succeed: $output", output.contains("\"state\":\"done\""))
            assertTrue("persisted value must match: $output",
                output.contains("persistedValue") && output.contains(expectedValue))
            assertTrue("origin must be https://appassets.androidplatform.net: $output",
                output.contains("\"origin\":\"https://appassets.androidplatform.net\""))
            assertTrue("isSecureContext must be true: $output",
                output.contains("\"isSecureContext\":true"))

            InstrumentationRegistry.getInstrumentation().sendStatus(0, resultBundle)
        }
    }

    private fun poll(v: WebView, l: CountDownLatch, done: (String) -> Unit) {
        v.evaluateJavascript("JSON.stringify(window.__probeResult||{state:'unknown'})") { j ->
            val t = j?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try { if (org.json.JSONObject(t).optString("state") in listOf("done","error")) { done(t); l.countDown() } else v.postDelayed({ poll(v,l,done) },300) }
            catch (_: Exception) { v.postDelayed({ poll(v,l,done) },300) }
        }
    }
}

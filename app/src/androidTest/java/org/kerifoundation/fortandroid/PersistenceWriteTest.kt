package org.kerifoundation.fortandroid

import android.net.Uri
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Phase A: Writes key/value to IndexedDB. Emits WRITE_PID via instrumentation Bundle. */
@RunWith(AndroidJUnit4::class)
class PersistenceWriteTest {
    @Test
    fun writeValueToIndexedDB() {
        val args = InstrumentationRegistry.getArguments()
        val key = args.getString("persistenceKey") ?: error("persistenceKey required")
        val value = args.getString("persistenceValue") ?: error("persistenceValue required")
        val pid = android.os.Process.myPid()

        // Emit PID through instrumentation result Bundle for reliable CI parsing
        val resultBundle = android.os.Bundle()
        resultBundle.putString("WRITE_PID", pid.toString())

        val instrCtx = InstrumentationRegistry.getInstrumentation().context
        val targetCtx = InstrumentationRegistry.getInstrumentation().targetContext
        val latch = CountDownLatch(1)
        var output = ""
        val pollingStarted = AtomicBoolean(false)

        android.os.Handler(targetCtx.mainLooper).post {
            val wv = WebView(targetCtx)
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            wv.settings.allowFileAccess = false
            wv.settings.allowContentAccess = false

            // Use instrumentation context for androidTest probe assets
            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/", TestAssetPathHandler(WebViewAssetLoader.AssetsPathHandler(instrCtx)))
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true).build()

            // Build final URL with encoded params before first loadUrl (one navigation)
            val finalUrl = Uri.parse("https://appassets.androidplatform.net/persistence-probe/write.html")
                .buildUpon()
                .appendQueryParameter("key", key)
                .appendQueryParameter("value", value)
                .build()
                .toString()

            wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(v: WebView, r: android.webkit.WebResourceRequest) =
                    loader.shouldInterceptRequest(r.url)
                override fun onPageFinished(v: WebView, url: String?) {
                    // Start polling only; never trigger another navigation.
                    // Guard against duplicate callbacks (redirects, etc.)
                    if (pollingStarted.compareAndSet(false, true)) {
                        poll(v, latch) { r -> output = r }
                    }
                }
            }
            wv.loadUrl(finalUrl)
        }
        assertTrue("write timed out", latch.await(20, TimeUnit.SECONDS))
        assertTrue("write must succeed: $output", output.contains("\"state\":\"done\""))

        // Verify origin and secure context
        assertTrue("origin must be https://appassets.androidplatform.net: $output",
            output.contains("\"origin\":\"https://appassets.androidplatform.net\""))
        assertTrue("isSecureContext must be true: $output",
            output.contains("\"isSecureContext\":true"))

        // Verify immediate IndexedDB readback
        assertTrue("write must confirm immediate readback: $output",
            output.contains("\"immediateReadback\":\"ok\""))

        // Send PID through instrumentation result
        InstrumentationRegistry.getInstrumentation().sendStatus(0, resultBundle)
    }

    private fun poll(v: WebView, l: CountDownLatch, done: (String) -> Unit) {
        v.evaluateJavascript("JSON.stringify(window.__probeResult||{state:'unknown'})") { j ->
            val t = j?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try { if (org.json.JSONObject(t).optString("state") in listOf("done","error")) { done(t); l.countDown() } else v.postDelayed({ poll(v,l,done) },300) }
            catch (_: Exception) { v.postDelayed({ poll(v,l,done) },300) }
        }
    }
}

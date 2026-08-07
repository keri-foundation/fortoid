package org.kerifoundation.fortandroid

import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Phase A: Writes key/value to IndexedDB. Prints WRITE_PID for CI capture. */
@RunWith(AndroidJUnit4::class)
class PersistenceWriteTest {
    @Test
    fun writeValueToIndexedDB() {
        val args = InstrumentationRegistry.getArguments()
        val key = args.getString("persistenceKey") ?: error("persistenceKey required")
        val value = args.getString("persistenceValue") ?: error("persistenceValue required")
        val pid = android.os.Process.myPid()
        println("WRITE_PID=$pid")

        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val latch = CountDownLatch(1)
        var output = ""

        android.os.Handler(ctx.mainLooper).post {
            val wv = WebView(ctx)
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            wv.settings.allowFileAccess = false
            wv.settings.allowContentAccess = false

            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/", TestAssetPathHandler(WebViewAssetLoader.AssetsPathHandler(ctx)))
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true).build()

            wv.webViewClient = object : androidx.webkit.WebViewClientCompat() {
                override fun shouldInterceptRequest(v: WebView, r: android.webkit.WebResourceRequest) =
                    loader.shouldInterceptRequest(r.url)
                override fun onPageFinished(v: WebView, url: String?) {
                    v.loadUrl("https://appassets.androidplatform.net/persistence-probe/write.html?key=$key&value=${java.net.URLEncoder.encode(value, "UTF-8")}")
                    poll(v, latch) { r -> output = r }
                }
            }
            wv.loadUrl("https://appassets.androidplatform.net/persistence-probe/write.html")
        }
        assertTrue("write timed out", latch.await(20, TimeUnit.SECONDS))
        assertTrue("write must succeed: $output", output.contains("\"state\":\"done\""))
    }

    private fun poll(v: WebView, l: CountDownLatch, done: (String) -> Unit) {
        v.evaluateJavascript("JSON.stringify(window.__probeResult||{state:'unknown'})") { j ->
            val t = j?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try { if (org.json.JSONObject(t).optString("state") in listOf("done","error")) { done(t); l.countDown() } else v.postDelayed({ poll(v,l,done) },300) }
            catch (_: Exception) { v.postDelayed({ poll(v,l,done) },300) }
        }
    }
}

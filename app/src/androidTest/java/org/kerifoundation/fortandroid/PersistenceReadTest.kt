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

/** Phase B: Reads persisted key/value from IndexedDB after force-stop. */
@RunWith(AndroidJUnit4::class)
class PersistenceReadTest {
    @Test
    fun readValueFromIndexedDB() {
        val args = InstrumentationRegistry.getArguments()
        val key = args.getString("persistenceKey") ?: error("persistenceKey required")
        val expectedValue = args.getString("persistenceValue") ?: error("persistenceValue required")
        val pid = android.os.Process.myPid()
        println("READ_PID=$pid")

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
                    v.evaluateJavascript(
                        "window.__probeParams={key:'$key',value:'$expectedValue'};" +
                        "var s=document.createElement('script');" +
                        "s.src='persistence-probe/read.html';" +
                        "document.head.appendChild(s);", null)
                    poll(v, latch) { r -> output = r }
                }
            }
            wv.loadUrl("https://appassets.androidplatform.net/persistence-probe/read.html")
        }
        assertTrue("read timed out", latch.await(20, TimeUnit.SECONDS))
        assertTrue("read must succeed: $output", output.contains("\"state\":\"done\""))
        assertTrue("persisted value must match: $output",
            output.contains("persistedValue") && output.contains(expectedValue))
    }

    private fun poll(v: WebView, l: CountDownLatch, done: (String) -> Unit) {
        v.evaluateJavascript("JSON.stringify(window.__probeResult||{state:'unknown'})") { j ->
            val t = j?.trim('"')?.replace("\\\"", "\"") ?: "{}"
            try { if (org.json.JSONObject(t).optString("state") in listOf("done","error")) { done(t); l.countDown() } else v.postDelayed({ poll(v,l,done) },300) }
            catch (_: Exception) { v.postDelayed({ poll(v,l,done) },300) }
        }
    }
}

package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class RuntimeEntrypointPolicyTest {
    @Test
    fun policyAllowsHttpsDataAndWasmButRejectsJavaScriptEvaluation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun evaluate(script: String): String? {
                val result = AtomicReference<String?>()
                val latch = CountDownLatch(1)
                scenario.onActivity { activity ->
                    val field = MainActivity::class.java.getDeclaredField("webView")
                    field.isAccessible = true
                    (field.get(activity) as WebView).evaluateJavascript(script) {
                        result.set(it)
                        latch.countDown()
                    }
                }
                assertTrue("JavaScript callback timed out", latch.await(10, TimeUnit.SECONDS))
                return result.get()
            }

            val deadline = SystemClock.elapsedRealtime() + 90_000
            val ready = "location.href === 'https://appassets.androidplatform.net/app/index.html' && " +
                "document.readyState === 'complete' && " +
                "!!document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')"
            while (SystemClock.elapsedRealtime() < deadline && evaluate(ready) != "true") {
                Thread.sleep(500)
            }
            assertEquals("The production entrypoint did not load its policy", "true", evaluate(ready))

            val scriptUrl = "https://appassets.androidplatform.net/policy-probe.js"
            val dataUrl = "https://policy.invalid/data.json"
            val dataRequests = AtomicInteger()
            val probe = """
                window.__entryPolicyProbe = {state: 'pending'};
                (async () => {
                  const response = await fetch('$dataUrl');
                  const text = await response.text();
                  let evalError = null;
                  try { (0, eval)('(' + text + ')'); } catch (error) { evalError = error.name; }
                  const wasm = await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));
                  window.__entryPolicyProbe = {state: 'done', status: response.status,
                    data: JSON.parse(text).kind === 'JSON', evalError, wasm: !!wasm};
                })().catch(error => { window.__entryPolicyProbe = {state: 'error', name: error.name}; });
            """.trimIndent()
            scenario.onActivity { activity ->
                val field = MainActivity::class.java.getDeclaredField("webView")
                field.isAccessible = true
                val view = field.get(activity) as WebView
                val original = view.webViewClient
                // Serve only the synthetic fixtures; delegate other requests to the production client.
                view.webViewClient = object : WebViewClientCompat() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url.toString()
                        if (url == scriptUrl || url == dataUrl) {
                            val data = url == dataUrl
                            if (data) dataRequests.incrementAndGet()
                            val body = if (data) "{\"kind\":\"JSON\"}" else probe
                            val headers = mapOf("Access-Control-Allow-Origin" to "*", "Cross-Origin-Resource-Policy" to "cross-origin")
                            return WebResourceResponse(if (data) "application/json" else "text/javascript", "utf-8",
                                200, "OK", headers, ByteArrayInputStream(body.toByteArray(Charsets.UTF_8)))
                        }
                        return original.shouldInterceptRequest(view, request)
                    }
                }
            }
            evaluate("(function(){const s=document.createElement('script');s.src='$scriptUrl';document.head.append(s)})()")
            var outcome = JSONObject()
            while (SystemClock.elapsedRealtime() < deadline) {
                val raw = evaluate("JSON.stringify(window.__entryPolicyProbe)")
                if (raw != null && raw != "null") {
                    outcome = JSONObject(JSONTokener(raw).nextValue() as String)
                    if (outcome.optString("state") != "pending") break
                }
                Thread.sleep(500)
            }
            assertEquals("Entrypoint policy probe failed: $outcome", "done", outcome.optString("state"))
            assertEquals(1, dataRequests.get())
            assertEquals(200, outcome.optInt("status"))
            assertTrue("HTTPS data was not readable", outcome.optBoolean("data"))
            assertEquals("JavaScript evaluation was not rejected", "EvalError", outcome.optString("evalError"))
            assertTrue("WebAssembly was not available", outcome.optBoolean("wasm"))
        }
    }
}

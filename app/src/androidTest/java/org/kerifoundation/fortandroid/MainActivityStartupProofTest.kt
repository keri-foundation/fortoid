package org.kerifoundation.fortandroid

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Instrumentation proof that the production MainActivity successfully
 * loads the canonical FortWeb runtime under the expected trust boundary.
 *
 * Evidence classification: ANDROID-CANONICAL-STARTUP
 * — proves MainActivity loads the real producer entrypoint
 * — proves __FORT_RUNTIME_ORIGIN__ is injected before navigation
 * — proves secure context and trusted origin
 * — does NOT prove Pyodide/Worker execution
 */
@RunWith(AndroidJUnit4::class)
class MainActivityStartupProofTest {

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    @Test
    fun mainActivityLoadsCanonicalFortWebEntrypoint() {
        val pageLoaded = CountDownLatch(1)
        val originHolder = AtomicReference<String>()
        val pathHolder = AtomicReference<String>()
        val secureContextHolder = AtomicBoolean(false)
        val fortOriginHolder = AtomicReference<String>()
        val errorHolder = AtomicReference<String>()

        scenario = ActivityScenario.launch(MainActivity::class.java)
        scenario.onActivity { activity ->
            val wvField = MainActivity::class.java.getDeclaredField("webView")
            wvField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val wv = wvField.get(activity) as? WebView
            assertNotNull("MainActivity must have a WebView", wv)

            wv?.webViewClient = object : androidx.webkit.WebViewClientCompat() {

                override fun onPageFinished(view: WebView, url: String?) {
                    view.evaluateJavascript(
                        "(function(){" +
                        "return JSON.stringify({" +
                        "origin: location.origin," +
                        "pathname: location.pathname," +
                        "isSecureContext: window.isSecureContext || false," +
                        "fortOrigin: typeof window.__FORT_RUNTIME_ORIGIN__ === 'object' " +
                        "  ? window.__FORT_RUNTIME_ORIGIN__.documentOrigin : null" +
                        "});" +
                        "})()"
                    ) { json ->
                        val trimmed = json?.trim('"')?.replace("\\\"", "\"") ?: "{}"
                        try {
                            val result = org.json.JSONObject(trimmed)
                            originHolder.set(result.optString("origin", ""))
                            pathHolder.set(result.optString("pathname", ""))
                            secureContextHolder.set(result.optBoolean("isSecureContext", false))
                            val fo = result.optString("fortOrigin", "")
                            if (fo.isNotEmpty() && fo != "null") {
                                fortOriginHolder.set(fo)
                            }
                            pageLoaded.countDown()
                        } catch (_: Exception) {
                            errorHolder.set("JSON parse: $trimmed")
                            pageLoaded.countDown()
                        }
                    }
                }

                override fun onReceivedError(
                    view: WebView, request: android.webkit.WebResourceRequest,
                    error: androidx.webkit.WebResourceErrorCompat
                ) {
                    if (request.isForMainFrame) {
                        errorHolder.set("Main frame error: code=${error.errorCode} desc=${error.description}")
                        pageLoaded.countDown()
                    }
                }
            }
        }

        assertTrue("page load timed out", pageLoaded.await(30, TimeUnit.SECONDS))

        val loadError = errorHolder.get()
        if (loadError != null) {
            // If there's a load error, it might be the native error view
            // which means the startup failed — check if origin was set
            assertTrue("startup failed with error: $loadError", false)
        }

        assertEquals(
            "must load from trusted origin",
            "https://appassets.androidplatform.net", originHolder.get()
        )
        assertEquals(
            "must load canonical FortWeb entrypoint",
            "/app/index.html", pathHolder.get()
        )
        assertTrue("must be secure context", secureContextHolder.get())

        val fortOrigin = fortOriginHolder.get()
        assertNotNull("__FORT_RUNTIME_ORIGIN__ must be injected", fortOrigin)
        assertEquals(
            "injected origin must match trusted origin",
            "https://appassets.androidplatform.net", fortOrigin
        )
    }
}

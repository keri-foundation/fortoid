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
import java.util.concurrent.atomic.AtomicReference

/**
 * Instrumentation proof that the production MainActivity successfully
 * loads the canonical FortWeb runtime under the expected trust boundary.
 *
 * Observes the real production WebView non-invasively via periodic
 * evaluateJavascript polling. Does NOT replace FortWebViewClient.
 *
 * Evidence classification: ANDROID-CANONICAL-STARTUP
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
        val originHolder = AtomicReference<String>()
        val pathHolder = AtomicReference<String>()
        val secureContextHolder = AtomicReference<Boolean>()
        val fortOriginHolder = AtomicReference<String>()
        val titleHolder = AtomicReference<String>()
        val appRootHolder = AtomicReference<Boolean>()
        val done = CountDownLatch(1)

        scenario = ActivityScenario.launch(MainActivity::class.java)
        pollStartupState(done, originHolder, pathHolder, secureContextHolder,
            fortOriginHolder, titleHolder, appRootHolder)

        assertTrue("startup proof timed out", done.await(25, TimeUnit.SECONDS))

        assertEquals(
            "must load from trusted origin",
            "https://appassets.androidplatform.net", originHolder.get()
        )
        assertEquals(
            "must load canonical FortWeb entrypoint",
            "/app/index.html", pathHolder.get()
        )
        assertTrue("must be secure context", secureContextHolder.get() == true)

        val fortOrigin = fortOriginHolder.get()
        assertNotNull("__FORT_RUNTIME_ORIGIN__ must be injected", fortOrigin)
        assertEquals(
            "injected origin must match trusted origin",
            "https://appassets.androidplatform.net", fortOrigin
        )

        val title = titleHolder.get()
        assertNotNull("page must have a title", title)
        assertTrue("page title must not be empty", title!!.isNotEmpty())

        val hasAppRoot = appRootHolder.get()
        assertTrue("page must contain #app-root", hasAppRoot == true)
    }

    private fun pollStartupState(
        done: CountDownLatch,
        origin: AtomicReference<String>,
        path: AtomicReference<String>,
        secureContext: AtomicReference<Boolean>,
        fortOrigin: AtomicReference<String>,
        title: AtomicReference<String>,
        appRoot: AtomicReference<Boolean>
    ) {
        val deadline = System.currentTimeMillis() + 24_000

        fun schedulePoll() {
            if (done.count == 0L) return
            if (System.currentTimeMillis() > deadline) {
                done.countDown()
                return
            }
            try {
                scenario.onActivity { activity ->
                    val wvField = MainActivity::class.java.getDeclaredField("webView")
                    wvField.isAccessible = true
                    @Suppress("UNCHECKED_CAST")
                    val wv = wvField.get(activity) as? WebView
                    if (wv == null) {
                        activity.window?.decorView?.postDelayed({ schedulePoll() }, 500)
                        return@onActivity
                    }

                    wv.evaluateJavascript(
                        "(function(){" +
                        "return JSON.stringify({" +
                        "origin: location.origin || ''," +
                        "pathname: location.pathname || ''," +
                        "isSecureContext: window.isSecureContext || false," +
                        "fortOrigin: (window.__FORT_RUNTIME_ORIGIN__ && " +
                        "  window.__FORT_RUNTIME_ORIGIN__.documentOrigin) || null," +
                        "title: document.title || ''," +
                        "hasAppRoot: document.getElementById('app-root') !== null" +
                        "});" +
                        "})()"
                    ) { json ->
                        val trimmed = json?.trim('"')?.replace("\\\"", "\"") ?: "{}"
                        try {
                            val result = org.json.JSONObject(trimmed)
                            val o = result.optString("origin", "")
                            val p = result.optString("pathname", "")
                            if (o == "https://appassets.androidplatform.net"
                                && p == "/app/index.html") {
                                origin.set(o)
                                path.set(p)
                                secureContext.set(result.optBoolean("isSecureContext", false))
                                val fo = result.optString("fortOrigin", "")
                                if (fo.isNotEmpty() && fo != "null") fortOrigin.set(fo)
                                title.set(result.optString("title", ""))
                                appRoot.set(result.optBoolean("hasAppRoot", false))
                                done.countDown()
                            } else {
                                wv.postDelayed({ schedulePoll() }, 500)
                            }
                        } catch (_: Exception) {
                            wv.postDelayed({ schedulePoll() }, 500)
                        }
                    }
                }
            } catch (_: Exception) {
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                    { schedulePoll() }, 500
                )
            }
        }

        schedulePoll()
    }
}

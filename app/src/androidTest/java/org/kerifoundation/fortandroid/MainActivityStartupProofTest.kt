package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
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
 * Instrumentation proof that the production MainActivity successfully
 * loads the canonical FortWeb runtime under the expected trust boundary.
 *
 * Observes the real production WebView non-invasively via periodic
 * evaluateJavascript polling. Does NOT replace FortWebViewClient.
 *
 * A single poll is considered READY only when ALL required conditions
 * are simultaneously true — not merely when the URL matches.
 *
 * Evidence classification: ANDROID-CANONICAL-STARTUP
 */
@RunWith(AndroidJUnit4::class)
class MainActivityStartupProofTest {

    companion object {
        private const val TAG = "MainActivityStartupProof"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val CANONICAL_PATH = "/app/index.html"
        private const val POLL_INTERVAL_MS = 500L
        private const val TIMEOUT_MS = 24_000L
    }

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    data class StartupObservation(
        val webViewPresent: Boolean,
        val origin: String,
        val pathname: String,
        val isSecureContext: Boolean,
        val fortOrigin: String?,
        val title: String,
        val hasAppRoot: Boolean,
        val nativeErrorVisible: Boolean,
        val nativeErrorText: String?
    ) {
        val isReady: Boolean get() =
            webViewPresent &&
            origin == TRUSTED_ORIGIN &&
            pathname == CANONICAL_PATH &&
            isSecureContext &&
            fortOrigin == TRUSTED_ORIGIN &&
            hasAppRoot &&
            !nativeErrorVisible

        fun summary(): String = buildString {
            append("webView=$webViewPresent")
            append(" origin=$origin")
            append(" pathname=$pathname")
            append(" secureContext=$isSecureContext")
            append(" fortOrigin=$fortOrigin")
            append(" title=$title")
            append(" hasAppRoot=$hasAppRoot")
            append(" nativeErrorVisible=$nativeErrorVisible")
            if (nativeErrorText != null) append(" nativeErrorText=$nativeErrorText")
        }
    }

    @Test
    fun mainActivityLoadsCanonicalFortWebEntrypoint() {
        val lastObservation = AtomicReference<StartupObservation>()
        var lastStage = "NO_WEBVIEW"

        scenario = ActivityScenario.launch(MainActivity::class.java)
        val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS

        while (SystemClock.elapsedRealtime() < deadline) {
            val sampleLatch = CountDownLatch(1)
            val sample = AtomicReference<StartupObservation>()

            scenario.onActivity { activity ->
                val wvField = MainActivity::class.java.getDeclaredField("webView")
                wvField.isAccessible = true
                @Suppress("UNCHECKED_CAST")
                val wv = wvField.get(activity) as? WebView

                if (wv == null) {
                    // Check for native fail-closed UI
                    val errorViewField = MainActivity::class.java.getDeclaredField("errorView")
                    errorViewField.isAccessible = true
                    val errorView = errorViewField.get(activity) as? TextView
                    val errorVisible = errorView?.visibility == View.VISIBLE
                    val errorText = if (errorVisible) errorView?.text?.toString() else null
                    sample.set(StartupObservation(
                        webViewPresent = false, origin = "", pathname = "",
                        isSecureContext = false, fortOrigin = null, title = "",
                        hasAppRoot = false,
                        nativeErrorVisible = errorVisible, nativeErrorText = errorText
                    ))
                    if (errorVisible) {
                        Log.e(TAG, "STAGE=NATIVE_FAIL_CLOSED text=$errorText")
                        lastStage = "NATIVE_FAIL_CLOSED"
                    }
                    sampleLatch.countDown()
                    return@onActivity
                }

                // Non-invasive JS query through the real production WebView
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
                ) { jsResult ->
                    val obs = parseJsResult(jsResult)
                    sample.set(obs)
                    val newStage = when {
                        obs.isReady -> "READY"
                        obs.fortOrigin == TRUSTED_ORIGIN -> "ORIGIN_CONTRACT_VISIBLE"
                        obs.origin == TRUSTED_ORIGIN && obs.pathname == CANONICAL_PATH -> "NAVIGATION_COMMITTED"
                        obs.webViewPresent -> "WEBVIEW_PRESENT"
                        else -> "NO_WEBVIEW"
                    }
                    if (newStage != lastStage) {
                        Log.i(TAG, "STAGE=$newStage ${obs.summary()}")
                        lastStage = newStage
                    }
                    sampleLatch.countDown()
                }
            }

            // Wait for this sample on the test thread
            sampleLatch.await(POLL_INTERVAL_MS + 2000, TimeUnit.MILLISECONDS)
            val obs = sample.get() ?: continue
            lastObservation.set(obs)

            if (obs.nativeErrorVisible) {
                fail("Native fail-closed: ${obs.nativeErrorText ?: "no text"}")
            }

            if (obs.isReady) {
                Log.i(TAG, "STAGE=READY")
                // All assertions satisfied in one coherent snapshot — exit cleanly
                return
            }

            // Brief sleep on test thread before next poll
            Thread.sleep(POLL_INTERVAL_MS)
        }

        // Timeout — report the latest observation
        val latest = lastObservation.get()
        val report = latest?.summary() ?: "(no observation)"
        Log.e(TAG, "STAGE=TIMEOUT lastStage=$lastStage $report")
        fail("Canonical startup readiness not reached before timeout. stage=$lastStage $report")
    }

    private fun parseJsResult(raw: String?): StartupObservation {
        if (raw == null) return StartupObservation(
            webViewPresent = true, origin = "", pathname = "",
            isSecureContext = false, fortOrigin = null, title = "",
            hasAppRoot = false, nativeErrorVisible = false, nativeErrorText = null
        )
        // evaluateJavascript wraps the result in double quotes for string returns.
        // Strip outer quotes and unescape internal ones.
        val unquoted = raw.trim()
            .removeSurrounding("\"")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
        return try {
            val obj = org.json.JSONObject(unquoted)
            val fo = obj.optString("fortOrigin", "")
            StartupObservation(
                webViewPresent = true,
                origin = obj.optString("origin", ""),
                pathname = obj.optString("pathname", ""),
                isSecureContext = obj.optBoolean("isSecureContext", false),
                fortOrigin = if (fo.isNotEmpty() && fo != "null") fo else null,
                title = obj.optString("title", ""),
                hasAppRoot = obj.optBoolean("hasAppRoot", false),
                nativeErrorVisible = false,
                nativeErrorText = null
            )
        } catch (_: Exception) {
            StartupObservation(
                webViewPresent = true, origin = "", pathname = "",
                isSecureContext = false, fortOrigin = null, title = "",
                hasAppRoot = false,
                nativeErrorVisible = false, nativeErrorText = null
            )
        }
    }
}

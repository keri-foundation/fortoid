package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.kerifoundation.fort.bridge.BridgeContract
import java.io.FileInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Instrumentation proof that the production MainActivity reaches a usable
 * FortWeb runtime under the expected trust boundary.
 *
 * Readiness is decided exclusively by [StartupReadiness]. It requires a
 * rendered application (non-empty `#app-root`) AND a completed real
 * `vaults.list` runtime operation. The previous proof accepted an existing
 * `#app-root` plus the absence of a native error, which could pass while
 * application JavaScript or the worker was non-functional.
 *
 * Observation is non-invasive in the strongest sense: MainActivity keeps the
 * only bridge listener. The instrumentation test does NOT register a second
 * `addWebMessageListener` under the production object name, because AndroidX
 * rejects that outright (`jsObjectName bridge was already added for world`),
 * which would both break the observer and perturb the topology under test.
 *
 * Instead the test reads the diagnostics the production listener already
 * emits (`bridge log=`, `bridge js_error=`, ...) and turns them back into
 * [StartupBridgeEvent]s. A message can only appear there after MainActivity
 * has accepted it under the production origin and main-frame policy, so the
 * observed event is production-accepted evidence rather than test-synthesised
 * proof. The production WebView client is untouched and MainActivity is not
 * modified.
 *
 * Listener timing: the startup `vaults.list` requires the Pyodide worker, so
 * it is emitted well after launch; the logcat reader observes the whole buffer
 * for the run, never a window, which is also what keeps fatal latching sound.
 *
 * Evidence classification: ANDROID-CANONICAL-STARTUP
 */
@RunWith(AndroidJUnit4::class)
class MainActivityStartupProofTest {

    companion object {
        private const val TAG = "MainActivityStartupProof"

        /** Production tag: MainActivity logs accepted bridge payloads here. */
        private const val LOG_TAG = "FortAndroid"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val CANONICAL_PATH = "/app/index.html"
        private const val POLL_INTERVAL_MS = 500L

        // Cold-boot budget: rendering plus the Pyodide worker plus the startup
        // vaults.list RPC. The established worker proof already allows 210s for
        // the worker alone, so a shorter window here could only produce a false
        // negative on a cold emulator.
        private const val TIMEOUT_MS = 240_000L
        private const val MAX_EVENT_CHARS = 4096

        private const val DOM_QUERY = "(function(){" +
            "var root = document.getElementById('app-root');" +
            "return JSON.stringify({" +
            "origin: location.origin || ''," +
            "pathname: location.pathname || ''," +
            "isSecureContext: window.isSecureContext || false," +
            "fortOrigin: (window.__FORT_RUNTIME_ORIGIN__ && " +
            "  window.__FORT_RUNTIME_ORIGIN__.documentOrigin) || null," +
            "appRootPresent: root !== null," +
            "appRootChildCount: root ? root.children.length : 0" +
            "});" +
            "})()"
    }

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    /** Trust-boundary and DOM state sampled from the production page. */
    private data class PageSample(
        val origin: String,
        val pathname: String,
        val isSecureContext: Boolean,
        val fortOrigin: String?,
        val dom: StartupDomSnapshot,
        val jsEvaluationFailed: Boolean,
    ) {
        /** The document is the bundled runtime at the expected origin. */
        val trustBoundaryHolds: Boolean
            get() = origin == TRUSTED_ORIGIN &&
                pathname == CANONICAL_PATH &&
                isSecureContext &&
                fortOrigin == TRUSTED_ORIGIN

        fun summary(): String = buildString {
            append("origin=").append(origin)
            append(" pathname=").append(pathname)
            append(" secureContext=").append(isSecureContext)
            append(" fortOrigin=").append(fortOrigin)
            append(" appRootPresent=").append(dom.appRootPresent)
            append(" appRootChildCount=").append(dom.appRootChildCount)
            append(" jsEvaluationFailed=").append(jsEvaluationFailed)
        }
    }

    @Test
    fun mainActivityReachesReadyFortWebRuntime() {
        val lastSample = AtomicReference<PageSample>()
        val lastVerdict = AtomicReference<StartupVerdict>()
        val nativeErrorText = AtomicReference<String>()
        var lastStage = "NO_WEBVIEW"

        val startedAt = SystemClock.elapsedRealtime()

        // Defines the observation window: everything the production listener
        // logs from here on belongs to this run.
        clearProductionLog()

        scenario = ActivityScenario.launch(MainActivity::class.java)

        // No bridge listener is registered here on purpose. MainActivity owns
        // the only listener for the production object name, and a second
        // registration under that name is rejected by AndroidX, so observing
        // through the production listener's own diagnostics is the only route
        // that leaves the topology under test intact.

        val deadline = startedAt + TIMEOUT_MS

        while (SystemClock.elapsedRealtime() < deadline) {
            val sampleLatch = CountDownLatch(1)
            val sampleRef = AtomicReference<PageSample>()

            scenario.onActivity { activity ->
                val wv = productionWebView(activity)

                if (wv == null) {
                    val errorViewField = MainActivity::class.java.getDeclaredField("errorView")
                    errorViewField.isAccessible = true
                    val errorView = errorViewField.get(activity) as? TextView
                    if (errorView?.visibility == View.VISIBLE) {
                        nativeErrorText.set(errorView.text?.toString())
                    }
                    sampleLatch.countDown()
                    return@onActivity
                }

                wv.evaluateJavascript(DOM_QUERY) { jsResult ->
                    sampleRef.set(parseSample(jsResult))
                    sampleLatch.countDown()
                }
            }

            sampleLatch.await(POLL_INTERVAL_MS + 3000, TimeUnit.MILLISECONDS)

            nativeErrorText.get()?.let { text ->
                fail("Native fail-closed before canonical startup: " + text)
            }

            val sample = sampleRef.get() ?: continue
            lastSample.set(sample)

            // The whole run's production diagnostics, never a window: fatal
            // events stay latched because StartupReadiness scans the full log.
            val events = productionBridgeEvents()
            val verdict = StartupReadiness.evaluate(
                dom = sample.dom,
                events = events,
            )
            lastVerdict.set(verdict)

            val stage = when {
                verdict.fatalFailure != null -> "FATAL_FAILURE"
                sample.jsEvaluationFailed -> "JS_EVALUATION_FAILED"
                !sample.trustBoundaryHolds -> "TRUST_BOUNDARY_PENDING"
                !verdict.renderedApplication -> "RENDER_NOT_READY"
                !verdict.runtimeOperationSucceeded -> "RUNTIME_OPERATION_NOT_READY"
                else -> "READY"
            }
            if (stage != lastStage) {
                Log.i(TAG, "STAGE=" + stage + " " + sample.summary() + " " + verdict.summary())
                lastStage = stage
            }

            if (verdict.fatalFailure != null) {
                fail(
                    "FortWeb reported a fatal startup condition; readiness cannot be " +
                        "established. failure=" + verdict.fatalFailure + " " + sample.summary(),
                )
            }

            if (verdict.isReady && sample.trustBoundaryHolds) {
                val elapsed = SystemClock.elapsedRealtime() - startedAt
                // The decisive live event, exactly as the production listener
                // received and logged it. No test-side synthesis.
                val operation = events.firstOrNull { event ->
                    val fields = StartupReadiness.parseFields(event.message)
                    fields["event"] == "request_end" && fields["outcome"] == "ok"
                }
                Log.i(TAG, "LIVE_EVENT " + (operation?.message ?: "(not found)"))
                Log.i(TAG, "STAGE=READY elapsedMs=" + elapsed + " " + sample.summary() + " " + verdict.summary())
                assertTrue("readiness requires a rendered application", verdict.renderedApplication)
                assertTrue(
                    "readiness requires a completed vaults.list runtime operation",
                    verdict.runtimeOperationSucceeded,
                )
                assertTrue(
                    "the successful runtime operation must be observable in the production log",
                    operation != null,
                )
                return
            }

            Thread.sleep(POLL_INTERVAL_MS)
        }

        val sample = lastSample.get()
        val verdict = lastVerdict.get()
        val observed = productionBridgeEvents()
            .map { it.message }
            .filter { it.contains("vaults.list") || it.contains("worker_") || it.contains("request_") }
            .take(8)

        fail(
            "Production startup readiness not reached before timeout." +
                " stage=" + lastStage +
                " page=" + (sample?.summary() ?: "(no DOM sample)") +
                " verdict=" + (verdict?.summary() ?: "(no verdict)") +
                " relevantEvents=" + observed +
                (if (verdict != null && verdict.renderedApplication && !verdict.runtimeOperationSucceeded) {
                    " NOTE: the application rendered but no vaults.list request_end reached the" +
                        " production bridge listener, so no runtime operation of record completed."
                } else {
                    ""
                }),
        )
    }

    /**
     * Producer diagnostics as emitted by the PRODUCTION bridge listener.
     *
     * MainActivity owns the only listener for the bridge object name, so the
     * test cannot register its own and must observe the app's own bounded log
     * output instead. A message reaches this log only after the production
     * listener has accepted it under the production origin and main-frame
     * policy, which is exactly the provenance the proof needs.
     */
    private fun productionBridgeEvents(): List<StartupBridgeEvent> =
        readProductionLog().lineSequence().mapNotNull(::parseProductionLogLine).toList()

    /** Start the observation window at the current end of the log buffer. */
    private fun clearProductionLog() {
        shell("logcat -c").close()
    }

    private fun readProductionLog(): String =
        shell("logcat -d -v brief -s $LOG_TAG:V").use { descriptor ->
            FileInputStream(descriptor.fileDescriptor).bufferedReader().use { it.readText() }
        }

    private fun shell(command: String) =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)

    /**
     * Turn one production log line into a bridge event.
     *
     * MainActivity emits `bridge log=<message>`, `bridge lifecycle=<message>`,
     * `bridge js_error=<message>` and `bridge unhandled_rejection=<message>`.
     * Anything else in the tag's stream is ignored rather than interpreted.
     */
    private fun parseProductionLogLine(line: String): StartupBridgeEvent? {
        val marker = "bridge "
        val markerIndex = line.indexOf(marker)
        if (markerIndex < 0) return null

        val remainder = line.substring(markerIndex + marker.length)
        val separator = remainder.indexOf('=')
        if (separator <= 0) return null

        val type = when (remainder.substring(0, separator).trim()) {
            "log" -> "log"
            "lifecycle" -> "lifecycle"
            BridgeContract.BRIDGE_JS_ERROR -> BridgeContract.BRIDGE_JS_ERROR
            BridgeContract.BRIDGE_UNHANDLED_REJECTION -> BridgeContract.BRIDGE_UNHANDLED_REJECTION
            else -> return null
        }

        val message = remainder.substring(separator + 1).trim()
        if (message.isEmpty()) return null

        return StartupBridgeEvent(
            type = type,
            message = if (message.length > MAX_EVENT_CHARS) message.take(MAX_EVENT_CHARS) else message,
        )
    }

    private fun productionWebView(activity: MainActivity): WebView? {
        val field = MainActivity::class.java.getDeclaredField("webView")
        field.isAccessible = true
        return field.get(activity) as? WebView
    }

    private fun parseSample(raw: String?): PageSample {
        if (raw == null) return unavailableSample()
        // evaluateJavascript wraps string returns in double quotes.
        val unquoted = raw.trim()
            .removeSurrounding("\"")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
        return try {
            val obj = JSONObject(unquoted)
            val fo = obj.optString("fortOrigin", "")
            PageSample(
                origin = obj.optString("origin", ""),
                pathname = obj.optString("pathname", ""),
                isSecureContext = obj.optBoolean("isSecureContext", false),
                fortOrigin = if (fo.isNotEmpty() && fo != "null") fo else null,
                dom = StartupDomSnapshot(
                    appRootPresent = obj.optBoolean("appRootPresent", false),
                    appRootChildCount = obj.optInt("appRootChildCount", 0),
                ),
                jsEvaluationFailed = false,
            )
        } catch (_: Exception) {
            unavailableSample()
        }
    }

    /** Render evidence is unavailable — never treated as success. */
    private fun unavailableSample() = PageSample(
        origin = "",
        pathname = "",
        isSecureContext = false,
        fortOrigin = null,
        dom = StartupDomSnapshot(appRootPresent = false, appRootChildCount = 0),
        jsEvaluationFailed = true,
    )
}

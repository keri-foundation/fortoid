package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Instrumentation proof that the production MainActivity prohibits Service
 * Worker registration on the trusted origin, while ordinary Web Worker and
 * Pyodide Worker support remain intact.
 *
 * Launches the real MainActivity (which installs the Android-owned
 * document-start prohibition guard before navigation), waits for the
 * canonical trusted-origin page, then attempts
 * navigator.serviceWorker.register(...) and requires deterministic rejection
 * with zero resulting registrations.
 *
 * Evidence classification: SERVICE-WORKER-REGISTRATION-PROHIBITION
 * This proves registration denial on hosted API 36. It does NOT prove
 * signing, Play Store delivery, or physical-device behavior.
 */
@RunWith(AndroidJUnit4::class)
class ServiceWorkerProhibitionProofTest {

    companion object {
        private const val TAG = "ServiceWorkerProhibitionProof"
        private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
        private const val SW_MARKER = "__FORT_SW_REGISTRATION_PROHIBITED__"
        private const val SW_PROBE_RESULT = "__FORT_SW_PROBE_RESULT__"
        private const val POLL_INTERVAL_MS = 300L
        private const val TIMEOUT_MS = 30_000L
    }

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    private fun webViewOf(activity: MainActivity): WebView {
        val wvField = MainActivity::class.java.getDeclaredField("webView")
        wvField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val wv = wvField.get(activity) as? WebView
            ?: throw AssertionError("MainActivity webView is unavailable")
        return wv
    }

    /**
     * Probe injected into the trusted-origin page. It records the document-start
     * guard marker, attempts to replace the guarded register via plain assignment
     * and Object.defineProperty, performs a real same-origin registration
     * attempt, and writes the settled result object into deterministic page
     * state. The Kotlin side polls window.__FORT_SW_PROBE_RESULT__ — it never
     * relies on evaluateJavascript awaiting an arbitrary Promise.
     */
    private val probeScript = """
        (function () {
            var result = {
                guardInstalled: window.$SW_MARKER === true,
                hasServiceWorkerApi: ('serviceWorker' in navigator),
                assignmentTamperSucceeded: null,
                definePropertyTamperSucceeded: null,
                registrationSucceeded: null,
                rejectionName: null,
                rejectionMessage: null,
                registrationsCount: null,
                registrationsError: null,
                controllerPresent: null
            };
            window.$SW_PROBE_RESULT = null;

            function finish() {
                if (result.hasServiceWorkerApi && navigator.serviceWorker.getRegistrations) {
                    navigator.serviceWorker.getRegistrations().then(function (regs) {
                        result.registrationsCount = regs.length;
                        result.controllerPresent = !!navigator.serviceWorker.controller;
                        window.$SW_PROBE_RESULT = result;
                    }).catch(function (e) {
                        result.registrationsError = String(e);
                        window.$SW_PROBE_RESULT = result;
                    });
                } else {
                    result.registrationsCount = 0;
                    result.controllerPresent = false;
                    window.$SW_PROBE_RESULT = result;
                }
            }

            function attemptRegistration(resolve) {
                try {
                    var p = navigator.serviceWorker.register('/sw.js');
                    if (p && typeof p.then === 'function') {
                        p.then(function () {
                            result.registrationSucceeded = true;
                            resolve();
                        }).catch(function (err) {
                            result.registrationSucceeded = false;
                            result.rejectionName = err ? err.name : null;
                            result.rejectionMessage = err ? err.message : null;
                            resolve();
                        });
                    } else {
                        result.registrationSucceeded = false;
                        resolve();
                    }
                } catch (e) {
                    result.registrationSucceeded = false;
                    result.rejectionName = e ? e.name : null;
                    result.rejectionMessage = e ? e.message : null;
                    resolve();
                }
            }

            if (!result.hasServiceWorkerApi) {
                result.registrationSucceeded = false;
                finish();
                return;
            }

            // Tamper attempt 1: plain assignment of a permissive replacement.
            var replacement = function () { return Promise.resolve({}); };
            try {
                navigator.serviceWorker.register = replacement;
                result.assignmentTamperSucceeded = (navigator.serviceWorker.register === replacement);
            } catch (e) {
                result.assignmentTamperSucceeded = false;
            }

            // Tamper attempt 2: redefine the property descriptor.
            try {
                Object.defineProperty(navigator.serviceWorker, 'register', {
                    value: replacement,
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
                result.definePropertyTamperSucceeded = (navigator.serviceWorker.register === replacement);
            } catch (e) {
                result.definePropertyTamperSucceeded = false;
            }

            attemptRegistration(function () { finish(); });
        })()
    """.trimIndent()

    private fun parseProbeResult(raw: String?): Map<String, Any?> {
        if (raw == null || raw == "null" || raw.isEmpty()) return emptyMap()
        val obj = org.json.JSONObject(raw)
        return obj.keys().asSequence().associateWith { key ->
            when (val v = obj.get(key)) {
                org.json.JSONObject.NULL -> null
                else -> v
            }
        }
    }

    @Test
    fun serviceWorkerRegistrationIsProhibitedOnTrustedOrigin() {
        scenario = ActivityScenario.launch(MainActivity::class.java)

        // Wait for the canonical trusted-origin page to finish loading so the
        // document-start guard has definitely been installed.
        val ready = AtomicReference<Boolean>(false)
        val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS
        while (SystemClock.elapsedRealtime() < deadline && ready.get() != true) {
            val latch = CountDownLatch(1)
            scenario.onActivity { activity ->
                val wv = webViewOf(activity)
                val script = "(location.origin === '$TRUSTED_ORIGIN' && document.readyState === 'complete')"
                wv.evaluateJavascript(script) { value ->
                    ready.set(value == "true")
                    latch.countDown()
                }
            }
            latch.await(POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        }

        if (ready.get() != true) {
            throw AssertionError("Trusted-origin page did not reach ready state within ${TIMEOUT_MS}ms")
        }

        // Inject the probe once; it runs in page context and writes its settled
        // result into deterministic page state for polling below.
        scenario.onActivity { activity ->
            webViewOf(activity).evaluateJavascript(probeScript, null)
        }

        // Poll the deterministic page-state variable until the probe settles.
        val result = AtomicReference<Map<String, Any?>>()
        val pollDeadline = SystemClock.elapsedRealtime() + TIMEOUT_MS
        while (SystemClock.elapsedRealtime() < pollDeadline) {
            val latch = CountDownLatch(1)
            scenario.onActivity { activity ->
                val wv = webViewOf(activity)
                wv.evaluateJavascript("window.$SW_PROBE_RESULT") { value ->
                    if (value != null && value != "null") {
                        result.set(parseProbeResult(value))
                    }
                    latch.countDown()
                }
            }
            latch.await(POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
            if (result.get() != null) break
        }

        val r = result.get() ?: throw AssertionError("Service Worker probe did not settle within ${TIMEOUT_MS}ms")
        Log.i(TAG, "PROBE_RESULT=$r")

        // 1. The Android-owned guard must have been installed at document-start.
        assertTrue("Service Worker prohibition guard must be installed", r["guardInstalled"] == true)

        // 2. Non-vacuous: the WebView must actually expose the SW API.
        assertTrue("navigator.serviceWorker must be present for a non-vacuous proof", r["hasServiceWorkerApi"] == true)

        // 3. Tamper resistance: plain assignment must not replace the guard.
        assertTrue("Assignment tamper must fail; guard must remain installed", r["assignmentTamperSucceeded"] == false)

        // 4. Tamper resistance: Object.defineProperty must not replace the guard.
        assertTrue("defineProperty tamper must fail; guard must remain installed", r["definePropertyTamperSucceeded"] == false)

        // 5. Registration must NOT have succeeded.
        assertTrue("Service Worker registration must not succeed", r["registrationSucceeded"] == false)

        // 6. Failure must be attributable to host policy, not 404/cross-origin/insecure context.
        assertTrue("Rejection must be a SecurityError from host policy, got ${r["rejectionName"]}", r["rejectionName"] == "SecurityError")

        // 7. Zero registrations must remain for the trusted origin.
        assertTrue("Zero registrations must remain, got ${r["registrationsCount"]}", r["registrationsCount"] == 0)

        // 8. No active Service Worker controller.
        assertTrue("navigator.serviceWorker.controller must be absent", r["controllerPresent"] == false)

        Log.i(TAG, "STAGE=PROHIBITED tamperAssignment=${r["assignmentTamperSucceeded"]} " +
            "tamperDefine=${r["definePropertyTamperSucceeded"]} rejection=${r["rejectionName"]} " +
            "registrations=${r["registrationsCount"]}")
    }
}

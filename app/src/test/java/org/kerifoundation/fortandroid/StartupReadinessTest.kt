package org.kerifoundation.fortandroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit contract for the startup readiness model.
 *
 * These cases pin the ANDROID-3 invariant: readiness requires a rendered
 * application AND a completed runtime operation, and the legacy
 * "`#app-root` exists" predicate is insufficient.
 */
class StartupReadinessTest {

    private fun log(message: String) = StartupBridgeEvent(type = "log", message = message)

    private fun rendered() = StartupDomSnapshot(appRootPresent = true, appRootChildCount = 4)

    private fun emptyRoot() = StartupDomSnapshot(appRootPresent = true, appRootChildCount = 0)

    private fun successfulVaultList() = log(
        "[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.list\" " +
            "request_id=\"runtime-1\" outcome=\"ok\" duration_ms=42",
    )

    private fun legacyPredicate(dom: StartupDomSnapshot): Boolean = dom.appRootPresent

    // --- Negative cases -----------------------------------------------------

    @Test
    fun `empty app root is not ready`() {
        val verdict = StartupReadiness.evaluate(emptyRoot(), emptyList())

        assertFalse("empty #app-root must not be ready", verdict.isReady)
        assertFalse(verdict.renderedApplication)
        assertFalse(verdict.runtimeOperationSucceeded)
    }

    @Test
    fun `empty app root satisfied the legacy predicate`() {
        // Regression guard for Evan's finding: the previous readiness check
        // passed on an empty root, so the new model must be strictly stronger.
        assertTrue(legacyPredicate(emptyRoot()))
        assertFalse(StartupReadiness.evaluate(emptyRoot(), emptyList()).isReady)
    }

    @Test
    fun `rendered application with worker failure is not ready`() {
        val events = listOf(
            log("[fortweb.runtime] event=worker_preload_start worker_id=\"0\""),
            log("[fortweb.runtime] event=worker_preload_failed level=\"error\" duration_ms=12 error=\"ImportError\""),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("worker failure must block readiness", verdict.isReady)
        assertTrue(verdict.renderedApplication)
        assertFalse(verdict.runtimeOperationSucceeded)
        assertTrue(verdict.fatalFailure!!.contains("worker_preload_failed"))
    }

    @Test
    fun `rendered application with failed runtime operation is not ready`() {
        // Worker started, but the real RPC failed. Distinct from "worker exists".
        val events = listOf(
            log("[fortweb.runtime] event=worker_preload_complete duration_ms=900"),
            log(
                "[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" " +
                    "request_id=\"runtime-1\" timeout_ms=30000",
            ),
            log(
                "[fortweb.runtime] event=terminal_failure level=\"error\" method=\"vaults.list\" " +
                    "request_id=\"runtime-1\" code=\"RUNTIME_ERROR\" message=\"worker died\" duration_ms=5",
            ),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("failed runtime operation must block readiness", verdict.isReady)
        assertTrue(verdict.renderedApplication)
        assertFalse(verdict.runtimeOperationSucceeded)
        assertTrue(verdict.fatalFailure!!.contains("terminal_failure"))
    }

    @Test
    fun `javascript error is not ready`() {
        val events = listOf(
            StartupBridgeEvent(type = "js_error", message = "Uncaught TypeError: x is not a function"),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("js_error must block readiness", verdict.isReady)
        assertTrue(verdict.fatalFailure!!.startsWith("js_error"))
    }

    @Test
    fun `unhandled rejection is not ready`() {
        val events = listOf(
            StartupBridgeEvent(type = "unhandled_rejection", message = "Runtime request rejected"),
        )

        assertFalse(StartupReadiness.evaluate(rendered(), events).isReady)
    }

    @Test
    fun `absence of failure is not evidence of success`() {
        // Only a request_start was observed: nothing failed, but nothing
        // completed either. Readiness must remain false.
        val events = listOf(
            log("[fortweb.runtime] event=worker_preload_complete duration_ms=900"),
            log("[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" request_id=\"runtime-1\""),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("no failure observed is not success", verdict.isReady)
        assertFalse(verdict.runtimeOperationSucceeded)
        assertNull(verdict.fatalFailure)
    }

    @Test
    fun `missing app root is not ready even after a successful operation`() {
        val verdict = StartupReadiness.evaluate(
            StartupDomSnapshot(appRootPresent = false, appRootChildCount = 0),
            listOf(successfulVaultList()),
        )

        assertFalse(verdict.isReady)
        assertTrue(verdict.runtimeOperationSucceeded)
        assertFalse(verdict.renderedApplication)
    }

    @Test
    fun `success of a different method does not satisfy readiness`() {
        val events = listOf(
            log(
                "[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.create\" " +
                    "request_id=\"runtime-9\" outcome=\"ok\" duration_ms=7",
            ),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("only the required operation counts", verdict.runtimeOperationSucceeded)
        assertFalse(verdict.isReady)
    }

    @Test
    fun `render error blocks readiness`() {
        val events = listOf(log("[fortweb.runtime] event=render_error level=\"error\" message=\"render threw\""))

        assertFalse(StartupReadiness.evaluate(rendered(), events).isReady)
    }

    // --- Positive cases -----------------------------------------------------

    @Test
    fun `rendered application with completed vault list is ready`() {
        val events = listOf(
            log("[fortweb.runtime] event=worker_preload_complete duration_ms=900"),
            log("[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" request_id=\"runtime-1\""),
            successfulVaultList(),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertTrue("expected ready: ${verdict.summary()}", verdict.isReady)
        assertTrue(verdict.renderedApplication)
        assertTrue(verdict.runtimeOperationSucceeded)
        assertNull(verdict.fatalFailure)
    }

    @Test
    fun `fresh install with zero vaults is ready`() {
        // A successful `vaults.list -> []` is a valid runtime operation, so an
        // empty wallet must not report startup as false.
        val events = listOf(
            log("[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" request_id=\"runtime-1\""),
            successfulVaultList(),
        )

        assertTrue(StartupReadiness.evaluate(rendered(), events).isReady)
    }

    @Test
    fun `required operation is configurable`() {
        val events = listOf(successfulVaultList())

        val verdict = StartupReadiness.evaluate(rendered(), events, requiredOperation = "vaults.summary")

        assertFalse(verdict.runtimeOperationSucceeded)
    }

    @Test
    fun `verdict summary reports all three components`() {
        val verdict = StartupReadiness.evaluate(rendered(), listOf(successfulVaultList()))

        assertEquals(
            "renderedApplication=true runtimeOperationSucceeded=true fatalFailure=none",
            verdict.summary(),
        )
    }

    // --- Parsing and latching -------------------------------------------------

    @Test
    fun `fatal event after partial success still latches failure`() {
        // A later successful request must not clear an earlier fatal failure.
        val events = listOf(
            log("[fortweb.runtime] event=render_error level=\"error\" message=\"render threw\""),
            successfulVaultList(),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertTrue(verdict.runtimeOperationSucceeded)
        assertFalse("latched fatal failure must keep readiness false", verdict.isReady)
        assertTrue(verdict.fatalFailure!!.startsWith("render_error"))
    }

    @Test
    fun `unknown messages are ignored`() {
        val events = listOf(
            log("some unrelated chrome message"),
            log("[fortweb.runtime] event=route_change level=\"info\" path=\"#/\""),
            StartupBridgeEvent(type = "log", message = ""),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertNull("unrecognised messages must not be treated as fatal", verdict.fatalFailure)
        assertFalse(verdict.runtimeOperationSucceeded)
    }

    @Test
    fun `success requires exact structured fields not substrings`() {
        val events = listOf(
            // outcome is not ok
            log("[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.list\" outcome=\"failed\""),
            // right outcome but wrong method
            log("[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.summary\" outcome=\"ok\""),
            // the word "ok" appears only inside an unrelated field value
            log("[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" note=\"ok\""),
            // request_end nested in another token must not match
            log("[fortweb.runtime] event=not_request_end method=\"vaults.list\" outcome=\"ok\""),
        )

        val verdict = StartupReadiness.evaluate(rendered(), events)

        assertFalse("only exact field matches count", verdict.runtimeOperationSucceeded)
        assertFalse(verdict.isReady)
    }

    @Test
    fun `duplicate successful request_end remains ready`() {
        val events = listOf(successfulVaultList(), successfulVaultList())

        assertTrue(StartupReadiness.evaluate(rendered(), events).isReady)
    }

    @Test
    fun `field values containing spaces are parsed correctly`() {
        val events = listOf(
            log(
                "[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.list\" " +
                    "outcome=\"ok\" message=\"vault list refreshed with 0 entries\"",
            ),
        )

        assertTrue(StartupReadiness.evaluate(rendered(), events).runtimeOperationSucceeded)
    }

    // --- Real producer grammar fixtures -------------------------------------
    //
    // Field sets, ordering, and value quoting below are transcribed from the
    // current FortWeb producer sources, not invented:
    //   bridge.ts   request_start / request_end / terminal_failure field sets
    //   logger.ts   "[fortweb.runtime] event=<name> key=value" formatting,
    //               with strings JSON-quoted and numbers bare
    //   global-handlers.ts  js_error / unhandled_rejection payload shape
    // The producer's own runtime-canary.spec.ts matches request_end successes
    // with the same semantics asserted here.

    @Test
    fun `accepts a genuine producer request_end message`() {
        // bridge.ts: postLog("request_end", { level, method, request_id, outcome, duration_ms })
        val genuine = log(
            "[fortweb.runtime] event=request_end level=\"info\" method=\"vaults.list\" " +
                "request_id=\"runtime-1757520000000-0\" outcome=\"ok\" duration_ms=37",
        )

        assertTrue(
            "genuine producer success message must satisfy the required operation",
            StartupReadiness.evaluate(rendered(), listOf(genuine)).runtimeOperationSucceeded,
        )
    }

    @Test
    fun `accepts a genuine producer request_start and terminal_failure pair as fatal`() {
        val start = log(
            "[fortweb.runtime] event=request_start level=\"info\" method=\"vaults.list\" " +
                "request_id=\"runtime-1757520000000-0\" timeout_ms=30000",
        )
        // bridge.ts: { level, method, request_id, code, message, duration_ms }
        val terminal = log(
            "[fortweb.runtime] event=terminal_failure level=\"error\" method=\"vaults.list\" " +
                "request_id=\"runtime-1757520000000-0\" code=\"RUNTIME_ERROR\" " +
                "message=\"Runtime request failed.\" duration_ms=12",
        )

        val verdict = StartupReadiness.evaluate(rendered(), listOf(start, terminal))

        assertFalse(verdict.isReady)
        assertTrue(verdict.fatalFailure!!.startsWith("terminal_failure"))
    }

    @Test
    fun `accepts a genuine producer worker_preload_complete message`() {
        // wallet-worker.py: emit_runtime_diagnostic("worker_preload_complete", duration_ms=...)
        val preload = log("[fortweb.runtime] event=worker_preload_complete duration_ms=812")

        val verdict = StartupReadiness.evaluate(rendered(), listOf(preload))

        // Positive worker evidence is recorded, but preload alone is not a
        // completed runtime operation.
        assertNull(verdict.fatalFailure)
        assertFalse(verdict.runtimeOperationSucceeded)
        assertFalse(verdict.isReady)
    }

    @Test
    fun `accepts a genuine producer js_error payload`() {
        // global-handlers.ts: postError("js_error", message, { source, lineno, colno })
        // NOTE: js_error carries no `event=` field; it is recognised by type.
        val jsError = StartupBridgeEvent(
            type = "js_error",
            message = "Uncaught ReferenceError: foo is not defined " +
                "source=\"https://appassets.androidplatform.net/app/app/main.js\" lineno=\"42\" colno=\"7\"",
        )

        val verdict = StartupReadiness.evaluate(rendered(), listOf(jsError))

        assertFalse(verdict.isReady)
        assertTrue(verdict.fatalFailure!!.startsWith("js_error"))
    }

    @Test
    fun `rejects a message that merely contains the success tokens out of order`() {
        // Guards against reverting to loose substring matching: the tokens are
        // present, but not as the request_end field set.
        val decoy = log(
            "[fortweb.runtime] event=route_change level=\"info\" " +
                "note=\"event=request_end method=vaults.list outcome=ok\"",
        )

        assertFalse(StartupReadiness.evaluate(rendered(), listOf(decoy)).runtimeOperationSucceeded)
    }
}

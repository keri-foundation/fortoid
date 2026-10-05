package org.kerifoundation.fortandroid

import org.kerifoundation.fort.bridge.BridgeContract

/**
 * Positive-evidence startup readiness model for the bundled FortWeb runtime.
 *
 * Readiness requires BOTH:
 *
 *  1. a meaningful rendered application state, and
 *  2. at least one completed non-mutating runtime operation.
 *
 * Absence of failure is deliberately NOT treated as evidence of success.
 * An existing but empty `#app-root` element satisfies neither condition: the
 * shell may have parsed while application JavaScript or the Pyodide worker
 * never became functional.
 *
 * The operation of record is the startup vault refresh issued by FortWeb
 * `bootstrap()` -> `actions.refreshVaults()` -> `bridge.request(vaults.list)`.
 * It is non-mutating, and on a fresh install with zero vaults a successful
 * `vaults.list -> []` is a valid completion.
 *
 * Producer evidence consumed here is the existing FortWeb bridge diagnostic
 * surface (see `app/runtime/logger.ts` and `app/runtime/bridge.ts`); no
 * FortWeb-side contract change is required.
 */
data class StartupDomSnapshot(
    /** `document.getElementById('app-root') !== null` */
    val appRootPresent: Boolean,
    /** Number of element children rendered into `#app-root`. */
    val appRootChildCount: Int,
)

/** A single payload received from the FortWeb native bridge. */
data class StartupBridgeEvent(
    /** Producer message type: `log`, `lifecycle`, `js_error`, `unhandled_rejection`. */
    val type: String,
    /** Formatted producer message, e.g. `[fortweb.runtime] event=request_end ...`. */
    val message: String,
)

/** Evaluated startup state. Ready only when every positive condition holds. */
data class StartupVerdict(
    val renderedApplication: Boolean,
    val runtimeOperationSucceeded: Boolean,
    val fatalFailure: String?,
) {
    val isReady: Boolean
        get() = renderedApplication && runtimeOperationSucceeded && fatalFailure == null

    fun summary(): String = buildString {
        append("renderedApplication=$renderedApplication")
        append(" runtimeOperationSucceeded=$runtimeOperationSucceeded")
        append(" fatalFailure=").append(fatalFailure ?: "none")
    }
}

object StartupReadiness {

    /** FortWeb method emitted by `bootstrap()` -> `actions.refreshVaults()`. */
    const val DEFAULT_REQUIRED_OPERATION = "vaults.list"

    /**
     * Producer diagnostics that mean the runtime did not reach a usable state.
     * Matched against the parsed `event` field by exact equality — never by
     * substring search over the raw message.
     */
    private val FATAL_PRODUCER_EVENTS = setOf(
        "terminal_failure",
        "worker_preload_failed",
        "render_error",
        "initial_vault_refresh_failed",
        "request_timeout",
    )

    /** Producer message prefix emitted by `app/runtime/logger.ts`. */
    private const val MESSAGE_PREFIX = "[fortweb.runtime] "

    /**
     * `key=value` tokeniser. Values are either JSON-quoted (producer
     * `JSON.stringify` of a string, which may contain spaces and escapes) or
     * bare (numbers, booleans).
     */
    private val FIELD_PATTERN = Regex("""([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|\S*)""")

    /**
     * Parse the producer's formatted diagnostic into its structured fields.
     * Returns an empty map for anything that is not a recognisable producer
     * diagnostic, so unknown payloads are ignored rather than interpreted.
     */
    internal fun parseFields(message: String): Map<String, String> {
        val body = message.removePrefix(MESSAGE_PREFIX)
        val fields = LinkedHashMap<String, String>()
        for (match in FIELD_PATTERN.findAll(body)) {
            fields[match.groupValues[1]] = unquote(match.groupValues[2])
        }
        return fields
    }

    private fun unquote(raw: String): String {
        if (raw.length < 2 || !raw.startsWith("\"") || !raw.endsWith("\"")) return raw
        val inner = raw.substring(1, raw.length - 1)
        val out = StringBuilder(inner.length)
        var index = 0
        while (index < inner.length) {
            val ch = inner[index]
            if (ch == '\\' && index + 1 < inner.length) {
                when (val next = inner[index + 1]) {
                    '"' -> out.append('"')
                    '\\' -> out.append('\\')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    else -> out.append(next)
                }
                index += 2
            } else {
                out.append(ch)
                index += 1
            }
        }
        return out.toString()
    }

    /**
     * Evaluate startup readiness from a DOM snapshot and the bridge events
     * observed so far.
     *
     * Callers MUST pass the complete accumulated event log, never a window of
     * recent events. Fatal events are latched: because the verdict scans the
     * whole log, a later success cannot clear an earlier fatal failure.
     *
     * @param dom latest `#app-root` observation
     * @param events every bridge payload observed since launch
     * @param requiredOperation method whose successful completion counts as
     *   the runtime operation of record
     */
    fun evaluate(
        dom: StartupDomSnapshot,
        events: List<StartupBridgeEvent>,
        requiredOperation: String = DEFAULT_REQUIRED_OPERATION,
    ): StartupVerdict = StartupVerdict(
        renderedApplication = dom.appRootPresent && dom.appRootChildCount > 0,
        runtimeOperationSucceeded = events.any { isSuccessfulOperation(it, requiredOperation) },
        fatalFailure = events.firstNotNullOfOrNull { fatalReason(it) },
    )

    /** A positive completion for the required method, by exact field values. */
    private fun isSuccessfulOperation(event: StartupBridgeEvent, requiredOperation: String): Boolean {
        val fields = parseFields(event.message)
        return fields["event"] == "request_end" &&
            fields["method"] == requiredOperation &&
            fields["outcome"] == "ok"
    }

    private fun fatalReason(event: StartupBridgeEvent): String? {
        if (
            event.type == BridgeContract.BRIDGE_JS_ERROR ||
            event.type == BridgeContract.BRIDGE_UNHANDLED_REJECTION
        ) {
            return "${event.type}: ${event.message.take(200)}"
        }
        val name = parseFields(event.message)["event"] ?: return null
        if (name !in FATAL_PRODUCER_EVENTS) return null
        return "$name :: ${event.message.take(200)}"
    }
}

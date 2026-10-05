package org.kerifoundation.fort.bridge

/**
 * Android constants for the FortWeb native bridge surface consumed by
 * MainActivity. The current FortWeb producer posts these discriminants over
 * the window.bridge handler (see payload app/runtime/logger.js and
 * app/runtime/global-handlers.js).
 */
object BridgeContract {

    /** JS-visible bridge object name — must match the host-exposed `window.bridge` surface. */
    const val HANDLER_NAME = "bridge"

    // Producer-native message types (JS → Android)
    const val BRIDGE_JS_ERROR = "js_error"
    const val BRIDGE_UNHANDLED_REJECTION = "unhandled_rejection"
    const val BRIDGE_LOG = "log"
    const val BRIDGE_LIFECYCLE = "lifecycle"
}

package org.kerifoundation.fortandroid

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView

/**
 * Debug-only probe Activity hosting a WebView for persistence instrumentation.
 *
 * Lives in the debug source set so the WebView receives an Activity Context
 * and is attached to a view hierarchy. This is the documented Android WebView
 * requirement — unattached WebViews created with application/target context
 * may lose lifecycle, renderer, or storage callbacks.
 *
 * NOT included in release builds.
 */
class PersistenceProbeActivity : Activity() {
    lateinit var webView: WebView
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false

        setContentView(webView)
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}

package org.kerifoundation.fortandroid

import android.app.Activity
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * Debug-only probe Activity for persistence proof.
 * Runs under the target application UID/data directory.
 * Absent from release builds.
 */
class PersistenceProbeActivity : Activity() {
    lateinit var webView: WebView
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        setContentView(webView)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

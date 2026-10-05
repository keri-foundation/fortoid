package org.kerifoundation.fortandroid

import android.app.Activity
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * Debug-only probe Activity hosting a single WebView for worker instrumentation.
 *
 * This Activity lives in the debug source set so it belongs to the target
 * application package (org.kerifoundation.fortandroid), not the instrumentation
 * test package (org.kerifoundation.fortandroid.test). ActivityScenario requires
 * the Activity to be in the target process.
 *
 * NOT included in release builds.
 */
class WorkerProbeActivity : Activity() {
    lateinit var webView: WebView
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        configureRuntimeSettings(webView.settings)
        setContentView(webView)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

/** Apply the same WebSettings used in production MainActivity. */
fun configureRuntimeSettings(settings: WebSettings) {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.allowFileAccessFromFileURLs = false
    settings.allowUniversalAccessFromFileURLs = false
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.mediaPlaybackRequiresUserGesture = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    settings.setSupportMultipleWindows(false)
}

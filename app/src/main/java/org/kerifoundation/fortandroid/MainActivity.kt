package org.kerifoundation.fortandroid

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.SafeBrowsingResponseCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
    private lateinit var rootLayout: FrameLayout
    private lateinit var errorView: TextView
    private lateinit var assetLoader: WebViewAssetLoader

    private var webView: WebView? = null
    private var rendererRecoveryAttempts = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)

        rootLayout = findViewById(R.id.main)
        errorView = findViewById(R.id.error_text)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showError(R.string.webview_unsupported_message)
            return
        }

        attachFreshWebView(loadPayload = true)
    }

    override fun onDestroy() {
        destroyWebView(webView)
        webView = null
        super.onDestroy()
    }

    private fun attachFreshWebView(loadPayload: Boolean) {
        errorView.visibility = View.GONE

        val freshWebView = createConfiguredWebView()
        rootLayout.addView(freshWebView, 0)
        webView = freshWebView

        if (loadPayload) {
            freshWebView.loadUrl(PAYLOAD_URL)
        }
    }

    @Suppress("DEPRECATION")
    private fun createConfiguredWebView(): WebView {
        val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(isDebuggable)

        return WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
            )
            setBackgroundColor(Color.WHITE)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                javaScriptCanOpenWindowsAutomatically = false
                mediaPlaybackRequiresUserGesture = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                safeBrowsingEnabled = true
                setSupportMultipleWindows(false)
            }

            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            webViewClient = FortWebViewClient()
        }
    }

    private fun handleExternalNavigation(uri: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, uri)
        try {
            startActivity(intent)
        } catch (exception: ActivityNotFoundException) {
            Log.w(LOG_TAG, "No handler for external URI: $uri", exception)
        }
    }

    private fun showError(messageResId: Int) {
        destroyWebView(webView)
        webView = null
        errorView.setText(messageResId)
        errorView.visibility = View.VISIBLE
    }

    private fun destroyWebView(target: WebView?) {
        if (target == null) {
            return
        }

        rootLayout.removeView(target)
        target.stopLoading()
        target.webChromeClient = null
        target.destroy()
    }

    private fun isTrustedPayloadUri(uri: Uri?): Boolean {
        return uri != null &&
            uri.scheme == TRUSTED_SCHEME &&
            uri.host == TRUSTED_HOST &&
            uri.path?.startsWith(TRUSTED_PATH_PREFIX) == true
    }

    private inner class FortWebViewClient : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            return assetLoader.shouldInterceptRequest(request.url)
        }

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val uri = request.url

            if (isTrustedPayloadUri(uri)) {
                return false
            }

            if (uri.scheme == TRUSTED_SCHEME) {
                handleExternalNavigation(uri)
            }

            return true
        }

        override fun onReceivedSslError(
            view: WebView,
            handler: SslErrorHandler,
            error: SslError
        ) {
            handler.cancel()
        }

        override fun onSafeBrowsingHit(
            view: WebView,
            request: WebResourceRequest,
            threatType: Int,
            callback: SafeBrowsingResponseCompat
        ) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_RESPONSE_BACK_TO_SAFETY)) {
                callback.backToSafety(true)
                return
            }

            super.onSafeBrowsingHit(view, request, threatType, callback)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(LOG_TAG, "WebView renderer exited. didCrash=${detail.didCrash()}")

            destroyWebView(view)

            rendererRecoveryAttempts += 1
            if (rendererRecoveryAttempts > MAX_RENDERER_RECOVERY_ATTEMPTS) {
                showError(R.string.webview_renderer_failed_message)
                return true
            }

            attachFreshWebView(loadPayload = true)
            return true
        }
    }

    private companion object {
        const val LOG_TAG = "FortAndroid"
        const val MAX_RENDERER_RECOVERY_ATTEMPTS = 1
        const val TRUSTED_HOST = "appassets.androidplatform.net"
        const val TRUSTED_PATH_PREFIX = "/assets/"
        const val TRUSTED_SCHEME = "https"
        const val PAYLOAD_URL = "https://appassets.androidplatform.net/assets/payload/index.html"
    }
}
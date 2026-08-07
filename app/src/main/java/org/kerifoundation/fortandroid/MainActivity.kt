package org.kerifoundation.fortandroid

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import android.widget.TextView
import java.io.ByteArrayInputStream
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.SafeBrowsingResponseCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayOutputStream
import org.kerifoundation.fort.bridge.BridgeContract
import org.json.JSONException
import org.json.JSONObject

private const val LOG_TAG = "FortAndroid"
private const val ELLIPSIS = "..."
private const val MAX_RENDERER_RECOVERY_ATTEMPTS = 1
private const val MAX_BRIDGE_LOG_VALUE_CHARS = 160
private const val MAX_BRIDGE_PAYLOAD_CHARS = 4096
private const val NATIVE_PROOF_VECTOR = "android native bridge proof v1"
private const val TRUSTED_HOST = "appassets.androidplatform.net"
private const val TRUSTED_ORIGIN_RULE = "https://appassets.androidplatform.net"
private const val TRUSTED_PATH_PREFIX = "/"
private const val TRUSTED_SCHEME = "https"
private const val PAYLOAD_URL = "https://appassets.androidplatform.net/index.html"
private const val PAYLOAD_ASSET_PREFIX = "payload/"
private const val PAYLOAD_INDEX_ASSET_PATH = "payload/index.html"
private const val PYODIDE_CDN_HOST = "cdn.jsdelivr.net"
private const val PYODIDE_CDN_PATH_PREFIX = "/pyodide/v"
private const val BUNDLED_PYODIDE_VERSION = "0.29.3"

internal object WebRequestPolicy {
    internal fun isTrustedPayloadParts(scheme: String?, host: String?, path: String?): Boolean {
        return scheme == TRUSTED_SCHEME &&
            host == TRUSTED_HOST &&
            path?.startsWith(TRUSTED_PATH_PREFIX) == true
    }

    fun isTrustedPayloadUri(uri: Uri?): Boolean {
        return uri != null && isTrustedPayloadParts(uri.scheme, uri.host, uri.path)
    }

    internal fun isTrustedBridgeParts(scheme: String?, host: String?): Boolean {
        return scheme == TRUSTED_SCHEME && host == TRUSTED_HOST
    }

    fun isTrustedBridgeOrigin(uri: Uri?): Boolean {
        return uri != null && isTrustedBridgeParts(uri.scheme, uri.host)
    }

    fun shouldBlockSubresource(uri: Uri?, isMainFrame: Boolean): Boolean {
        if (isTrustedPayloadUri(uri)) {
            return false
        }

        return !isMainFrame
    }

    internal fun shouldOpenExternallyParts(scheme: String?, host: String?, path: String?): Boolean {
        if (isTrustedPayloadParts(scheme, host, path)) return false

        return scheme == TRUSTED_SCHEME
    }

    fun shouldOpenExternally(uri: Uri?): Boolean {
        if (uri == null) return false
        return shouldOpenExternallyParts(uri.scheme, uri.host, uri.path)
    }

    /**
     * Redirect Pyodide CDN requests to the bundled local copy so the wrapper stays offline.
     */
    fun mapPyodideCdnToLocal(uri: Uri?): Uri? {
        if (uri == null) return null
        if (uri.scheme != TRUSTED_SCHEME || uri.host != PYODIDE_CDN_HOST) return null
        val path = uri.path ?: return null
        if (!path.startsWith(PYODIDE_CDN_PATH_PREFIX)) return null

        val afterPrefix = path.removePrefix(PYODIDE_CDN_PATH_PREFIX)
        val slashIdx = afterPrefix.indexOf('/')
        if (slashIdx < 0) return null
        val remainder = afterPrefix.substring(slashIdx + 1)

        val file = if (remainder.startsWith("full/")) {
            remainder.removePrefix("full/")
        } else {
            remainder
        }

        return Uri.parse("https://$TRUSTED_HOST/fortweb/vendor/pyodide/$BUNDLED_PYODIDE_VERSION/$file")
    }
}

class MainActivity : AppCompatActivity() {
    private lateinit var rootLayout: FrameLayout
    private lateinit var errorView: TextView
    private lateinit var assetLoader: WebViewAssetLoader

    private var webView: WebView? = null
    private var rendererRecoveryAttempts = 0
    private var nativeCommandSequence = 0
    private var nativeProofDispatched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)

        rootLayout = findViewById(R.id.main)

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, windowInsets ->
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
            val insets = windowInsets.getInsets(types)
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)

            WindowInsetsCompat.Builder(windowInsets)
                .setInsets(types, Insets.NONE)
                .build()
        }
        errorView = findViewById(R.id.error_text)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", PayloadRootPathHandler(WebViewAssetLoader.AssetsPathHandler(this)))
            .build()

        nativeProofDispatched = false

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
        nativeProofDispatched = false

        val freshWebView = createConfiguredWebView()
        rootLayout.addView(freshWebView, 0)
        webView = freshWebView

        if (loadPayload) {
            injectRuntimeOriginContract(freshWebView)
            freshWebView.loadUrl(PAYLOAD_URL)
        }
    }

    private fun injectRuntimeOriginContract(webView: WebView) {
        try {
            val stream = assets.open("payload/fortweb/app/runtime-origin-contract.json")
            val bytes = ByteArrayOutputStream()
            stream.copyTo(bytes)
            stream.close()
            val contractJson = bytes.toString("UTF-8")
            val script = "window.__FORT_RUNTIME_ORIGIN__ = $contractJson;"
            WebViewCompat.addDocumentStartJavaScript(webView, script, setOf(TRUSTED_ORIGIN_RULE))
        } catch (e: Exception) {
            Log.w(LOG_TAG, "Could not inject runtime-origin contract", e)
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
            setBackgroundColor(Color.parseColor("#F7F8F4"))

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
            installBridgeListener(this)
            webViewClient = FortWebViewClient()

            isFocusable = true
            isFocusableInTouchMode = true
            requestFocus(View.FOCUS_DOWN)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setAutoHandwritingEnabled(false)
            }

            @Suppress("ClickableViewAccessibility")
            setOnTouchListener { v, event ->
                if (event.action == MotionEvent.ACTION_DOWN && !v.isFocused) {
                    v.requestFocus()
                }
                false
            }
        }
    }

    private fun installBridgeListener(target: WebView) {
        WebViewCompat.addWebMessageListener(
            target,
            BridgeContract.HANDLER_NAME,
            setOf(TRUSTED_ORIGIN_RULE),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy
                ) {
                    if (!isMainFrame || !WebRequestPolicy.isTrustedBridgeOrigin(sourceOrigin)) {
                        Log.w(
                            LOG_TAG,
                            "Rejected bridge message from origin=$sourceOrigin mainFrame=$isMainFrame"
                        )
                        return
                    }

                    if (message.type != WebMessageCompat.TYPE_STRING) {
                        Log.w(LOG_TAG, "Rejected non-string bridge payload type=${message.type}")
                        return
                    }

                    val rawPayload = message.data
                    if (rawPayload.isNullOrBlank()) {
                        Log.w(LOG_TAG, "Rejected empty bridge payload")
                        return
                    }

                    if (rawPayload.length > MAX_BRIDGE_PAYLOAD_CHARS) {
                        Log.w(LOG_TAG, "Rejected oversized bridge payload (${rawPayload.length} chars)")
                        return
                    }

                    handleBridgeMessage(rawPayload)
                }
            }
        )
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

    private fun createBlockedSubresourceResponse(): WebResourceResponse {
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            ByteArrayInputStream(ByteArray(0))
        ).apply {
            setStatusCodeAndReasonPhrase(403, "Forbidden")
            responseHeaders = mapOf("Cache-Control" to "no-store")
        }
    }

    private fun handleBridgeMessage(rawPayload: String) {
        val envelope = try {
            JSONObject(rawPayload)
        } catch (exception: JSONException) {
            Log.w(LOG_TAG, "Rejected malformed bridge JSON", exception)
            return
        }

        val type = envelope.optString("type")
        if (type.isBlank()) {
            Log.w(LOG_TAG, "Rejected bridge payload with missing type")
            return
        }

        when (type) {
            BridgeContract.BRIDGE_LIFECYCLE -> handleLifecycleMessage(envelope)

            BridgeContract.BRIDGE_LOG -> Log.d(
                LOG_TAG,
                "bridge log=${boundedLogValue(envelope.optString("message"))}"
            )

            BridgeContract.BRIDGE_JS_ERROR, BridgeContract.BRIDGE_UNHANDLED_REJECTION -> Log.e(
                LOG_TAG,
                "bridge $type=${boundedLogValue(envelope.optString("message"))}"
            )

            BridgeContract.BRIDGE_CRYPTO_RESULT -> handleCryptoResult(envelope)

            else -> Log.w(LOG_TAG, "Rejected unsupported bridge type=$type")
        }
    }

    private fun handleLifecycleMessage(envelope: JSONObject) {
        val message = envelope.optString("message")
        Log.i(LOG_TAG, "bridge lifecycle=${boundedLogValue(message)}")

        if (message == BridgeContract.LIFECYCLE_READY && !nativeProofDispatched) {
            nativeProofDispatched = true
            dispatchNativeProofCommand()
        }
    }

    private fun dispatchNativeProofCommand() {
        val target = webView ?: run {
            Log.w(LOG_TAG, "Skipped native proof dispatch because WebView is unavailable")
            nativeProofDispatched = false
            return
        }

        val commandId = "android-proof-${++nativeCommandSequence}"
        val command = JSONObject()
            .put("id", commandId)
            .put("type", BridgeContract.WORKER_CMD_BLAKE3_HASH)
            .put("data", NATIVE_PROOF_VECTOR)

        val script = buildString {
            append("(function(){")
            append("if (typeof window.handleNativeCommand !== 'function') { return 'missing'; }")
            append("window.handleNativeCommand(")
            append(command.toString())
            append(");")
            append("return 'ok';")
            append("})();")
        }

        target.evaluateJavascript(script) { result ->
            when (result?.trim('"')) {
                "ok" -> Log.i(LOG_TAG, "Dispatched native proof command id=$commandId")
                "missing" -> {
                    nativeProofDispatched = false
                    Log.w(LOG_TAG, "Native proof dispatch skipped because handleNativeCommand is unavailable")
                }

                else -> {
                    nativeProofDispatched = false
                    Log.w(LOG_TAG, "Native proof dispatch returned unexpected result=$result")
                }
            }
        }
    }

    private fun handleCryptoResult(envelope: JSONObject) {
        val operationId = boundedLogValue(envelope.optString("id"))
        val error = envelope.optString("error").takeIf { it.isNotBlank() }
        if (error != null) {
            Log.e(LOG_TAG, "bridge crypto_result id=$operationId error=${boundedLogValue(error)}")
            return
        }

        val rawMessage = envelope.optString("message")
        if (rawMessage.isBlank()) {
            Log.w(LOG_TAG, "bridge crypto_result id=$operationId missing message payload")
            return
        }

        val payload = try {
            JSONObject(rawMessage)
        } catch (exception: JSONException) {
            Log.w(LOG_TAG, "bridge crypto_result id=$operationId malformed payload", exception)
            return
        }

        when (payload.optString("type")) {
            BridgeContract.WORKER_RES_BLAKE3_RESULT -> Log.i(
                LOG_TAG,
                "native proof hash=${boundedLogValue(payload.optString("hex"))}"
            )

            BridgeContract.WORKER_RES_ERROR -> Log.e(
                LOG_TAG,
                "bridge crypto_result id=$operationId workerError=${boundedLogValue(payload.optString("error"))}"
            )

            else -> Log.i(
                LOG_TAG,
                "bridge crypto_result id=$operationId type=${boundedLogValue(payload.optString("type"))}"
            )
        }
    }

    private fun boundedLogValue(value: String?, maxLength: Int = MAX_BRIDGE_LOG_VALUE_CHARS): String {
        if (value.isNullOrBlank()) {
            return ""
        }

        return if (value.length <= maxLength) {
            value
        } else {
            value.take(maxLength) + ELLIPSIS
        }
    }

    private fun addCrossOriginIsolationHeaders(response: WebResourceResponse): WebResourceResponse {
        val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.responseHeaders = headers
        return response
    }

    private fun addCdnRedirectHeaders(response: WebResourceResponse): WebResourceResponse {
        val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        response.responseHeaders = headers
        return response
    }

    private fun injectAndroidSafeAreaOverrides(target: WebView) {
        val css = ".lk-dialog-root--sheet { align-items: center; }"

        val js = "(function(){" +
            "var s=document.createElement('style');" +
            "s.id='android-safe-area-overrides';" +
            "s.textContent=${JSONObject.quote(css)};" +
            "var existing=document.getElementById('android-safe-area-overrides');" +
            "if(existing)existing.remove();" +
            "document.head.appendChild(s);" +
            "})()"

        target.evaluateJavascript(js, null)
        Log.i(LOG_TAG, "Injected Android CSS overrides (dialog centering)")
    }

    private class PayloadRootPathHandler(
        private val delegate: WebViewAssetLoader.AssetsPathHandler
    ) : WebViewAssetLoader.PathHandler {
        private val mimeOverrides = mapOf(
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "wasm" to "application/wasm",
            "svg" to "image/svg+xml",
            "toml" to "application/toml",
            "whl" to "application/zip",
            "zip" to "application/zip",
            "py" to "text/plain"
        )

        override fun handle(path: String): WebResourceResponse? {
            val normalizedPath = path.trimStart('/')
            val assetPath = when {
                normalizedPath.isEmpty() -> PAYLOAD_INDEX_ASSET_PATH
                normalizedPath.startsWith(PAYLOAD_ASSET_PREFIX) -> normalizedPath
                else -> "$PAYLOAD_ASSET_PREFIX$normalizedPath"
            }

            val resolved = delegate.handle(assetPath)?.let { assetPath to it }
                ?: return null

            val resolvedAssetPath = resolved.first
            val response = resolved.second

            val extension = resolvedAssetPath.substringAfterLast('.', missingDelimiterValue = "").lowercase()
            val expectedMimeType = mimeOverrides[extension]
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)

            if (!expectedMimeType.isNullOrBlank() && response.mimeType != expectedMimeType) {
                response.mimeType = expectedMimeType
            }

            return response
        }
    }

    private inner class FortWebViewClient : WebViewClientCompat() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            if (WebRequestPolicy.isTrustedPayloadUri(request.url)) {
                val response = assetLoader.shouldInterceptRequest(request.url)
                return response?.let { addCrossOriginIsolationHeaders(it) }
            }

            val localPyodideUri = WebRequestPolicy.mapPyodideCdnToLocal(request.url)
            if (localPyodideUri != null) {
                Log.i(LOG_TAG, "Pyodide CDN redirect: ${request.url.path} -> ${localPyodideUri.path}")
                val response = assetLoader.shouldInterceptRequest(localPyodideUri)
                if (response != null) {
                    return addCdnRedirectHeaders(response)
                }

                Log.w(
                    LOG_TAG,
                    "Missing bundled Pyodide asset for mapped request url=${boundedLogValue(request.url.toString())} local=${boundedLogValue(localPyodideUri.toString())}"
                )
                return createBlockedSubresourceResponse()
            }

            if (WebRequestPolicy.shouldBlockSubresource(request.url, request.isForMainFrame)) {
                Log.w(
                    LOG_TAG,
                    "Blocked off-origin subresource url=${boundedLogValue(request.url.toString())}"
                )
                return createBlockedSubresourceResponse()
            }

            return null
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            injectAndroidSafeAreaOverrides(view)
        }

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val uri = request.url

            if (WebRequestPolicy.isTrustedPayloadUri(uri)) {
                return false
            }

            if (WebRequestPolicy.shouldOpenExternally(uri)) {
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
}
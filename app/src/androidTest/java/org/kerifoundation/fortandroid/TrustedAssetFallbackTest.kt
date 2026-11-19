package org.kerifoundation.fortandroid

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TrustedAssetFallbackTest {
    @Test
    fun unmatchedTrustedHostRequestDoesNotFallThrough() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val field = MainActivity::class.java.getDeclaredField("webView")
                field.isAccessible = true
                val view = field.get(activity) as WebView
                val request = object : WebResourceRequest {
                    override fun getUrl(): Uri = Uri.parse("https://appassets.androidplatform.net:8443/probe.js")
                    override fun isForMainFrame(): Boolean = false
                    override fun isRedirect(): Boolean = false
                    override fun hasGesture(): Boolean = false
                    override fun getMethod(): String = "GET"
                    override fun getRequestHeaders(): Map<String, String> = emptyMap()
                }
                val response = view.webViewClient.shouldInterceptRequest(view, request)
                assertNotNull("An unmatched trusted-host request must not reach the network", response)
                assertEquals(403, response?.statusCode)
            }
        }
    }
}

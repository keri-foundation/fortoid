package org.kerifoundation.fortandroid

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebRequestPolicyTest {
    @Test
    fun trustedPayloadPartsAreRecognized() {
        assertTrue(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/index.html"
            )
        )
    }

    @Test
    fun fortwebSubpathIsTrusted() {
        assertTrue(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/fortweb/app/index.html"
            )
        )
    }

    @Test
    fun cleartextOffOriginSubresourceIsBlocked() {
        assertTrue(
            WebRequestPolicy.shouldBlockSubresourceParts(
                scheme = "http",
                host = "witness.example.org",
                path = "/health",
                isMainFrame = false
            )
        )
    }

    @Test
    fun httpsWalletServiceSubresourceIsAllowed() {
        // v2 permits HTTPS wallet-service data requests. Service URLs may come
        // from wallet configuration or OOBI discovery, so the host is not fixed
        // and must not be constrained to a hardcoded allowlist.
        assertFalse(
            WebRequestPolicy.shouldBlockSubresourceParts(
                scheme = "https",
                host = "witness.example.org",
                path = "/health",
                isMainFrame = false
            )
        )
        assertFalse(
            WebRequestPolicy.shouldBlockSubresourceParts(
                scheme = "https",
                host = "kf.example.org",
                path = "/bootstrap/config",
                isMainFrame = false
            )
        )
        assertFalse(
            WebRequestPolicy.shouldBlockSubresourceParts(
                scheme = "https",
                host = "watcher.example.org",
                path = "/oobi/EFgXY",
                isMainFrame = false
            )
        )
    }

    @Test
    fun nonHttpsSchemesAreBlockedForSubresources() {
        for (scheme in listOf("file", "content", "app", "ftp")) {
            assertTrue(
                "scheme $scheme must be refused for off-origin subresources",
                WebRequestPolicy.shouldBlockSubresourceParts(
                    scheme = scheme,
                    host = null,
                    path = "/etc/hosts",
                    isMainFrame = false
                )
            )
        }
    }

    @Test
    fun nullUriSubresourceIsBlocked() {
        // A request with no decidable scheme fails closed.
        assertTrue(
            WebRequestPolicy.shouldBlockSubresource(
                uri = null,
                isMainFrame = false
            )
        )
    }

    @Test
    fun trustedPayloadSubresourceIsNotBlocked() {
        assertFalse(
            WebRequestPolicy.shouldBlockSubresourceParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/app/index.html",
                isMainFrame = false
            )
        )
    }

    @Test
    fun remoteWalletServiceOriginIsNotATrustedAppOrBridgeOrigin() {
        // Transport permission for wallet-service data grants no trust: a remote
        // origin can never be the application origin or a bridge origin.
        assertFalse(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "kf.example.org",
                path = "/bootstrap/config"
            )
        )
        assertFalse(
            WebRequestPolicy.isTrustedBridgeParts(
                scheme = "https",
                host = "kf.example.org"
            )
        )
        assertFalse(
            WebRequestPolicy.shouldOpenExternallyParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/app/index.html"
            )
        )
    }

    @Test
    fun wrongHostIsNotTrusted() {
        assertFalse(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "example.com",
                path = "/index.html"
            )
        )
    }

    @Test
    fun wrongSchemeIsNotTrusted() {
        assertFalse(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "http",
                host = "appassets.androidplatform.net",
                path = "/index.html"
            )
        )
    }

    @Test
    fun topLevelNavigationIsNotBlockedBySubresourcePolicy() {
        assertFalse(
            WebRequestPolicy.shouldBlockSubresource(
                uri = null,
                isMainFrame = true
            )
        )
    }

    @Test
    fun trustedPayloadPartsRequireExactOrigin() {
        assertTrue(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/index.html"
            )
        )
        assertFalse(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "appassets.androidplatform.net.evil",
                path = "/index.html"
            )
        )
    }

    @Test
    fun trustedPayloadPartsRequireNonNullPath() {
        assertFalse(
            WebRequestPolicy.isTrustedPayloadParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = null
            )
        )
    }

    @Test
    fun bridgeOriginRequiresTrustedSchemeAndHost() {
        assertTrue(
            WebRequestPolicy.isTrustedBridgeParts(
                scheme = "https",
                host = "appassets.androidplatform.net"
            )
        )
        assertFalse(
            WebRequestPolicy.isTrustedBridgeParts(
                scheme = "https",
                host = "example.com"
            )
        )
    }

    @Test
    fun trustedBridgePartsRequireExactOrigin() {
        assertFalse(
            WebRequestPolicy.isTrustedBridgeParts(
                scheme = "http",
                host = "appassets.androidplatform.net"
            )
        )
        assertFalse(
            WebRequestPolicy.isTrustedBridgeParts(
                scheme = "https",
                host = "appassets.androidplatform.net.evil"
            )
        )
    }

    @Test
    fun offOriginHttpsNavigationIsOpenedExternally() {
        assertTrue(
            WebRequestPolicy.shouldOpenExternallyParts(
                scheme = "https",
                host = "example.com",
                path = "/docs"
            )
        )
    }

    @Test
    fun trustedPayloadNavigationIsNotOpenedExternally() {
        assertFalse(
            WebRequestPolicy.shouldOpenExternallyParts(
                scheme = "https",
                host = "appassets.androidplatform.net",
                path = "/fortweb/app/index.html"
            )
        )
    }

    @Test
    fun nonHttpsNavigationIsNotOpenedExternally() {
        assertFalse(
            WebRequestPolicy.shouldOpenExternallyParts(
                scheme = "http",
                host = "example.com",
                path = "/docs"
            )
        )
        assertFalse(
            WebRequestPolicy.shouldOpenExternallyParts(
                scheme = "mailto",
                host = null,
                path = "test@example.com"
            )
        )
    }
}

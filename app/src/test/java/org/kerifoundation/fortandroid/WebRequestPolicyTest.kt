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
    fun offOriginSubresourceIsBlocked() {
        assertTrue(
            WebRequestPolicy.shouldBlockSubresource(
                uri = null,
                isMainFrame = false
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

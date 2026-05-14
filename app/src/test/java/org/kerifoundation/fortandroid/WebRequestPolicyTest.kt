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
        assertFalse(WebRequestPolicy.shouldBlockSubresource(uri = null, isMainFrame = true))
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
}
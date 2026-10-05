package org.kerifoundation.fortandroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidRuntimeOriginContractTest {

    private val validContract = """
{
  "schema": "fortweb.runtime-origin.v1",
  "version": 1,
  "platform": "android-webview",
  "mode": "bundled-offline",
  "documentOrigin": "https://appassets.androidplatform.net",
  "appBaseUrl": "https://appassets.androidplatform.net/app/",
  "entryUrl": "https://appassets.androidplatform.net/app/index.html",
  "workerUrl": "https://appassets.androidplatform.net/app/runtime/wallet-worker.py",
  "configUrl": "https://appassets.androidplatform.net/pyscript-ci.toml",
  "storage": {
    "storageNamespace": "fortoid",
    "indexedDbRequired": true,
    "originPartition": "https://appassets.androidplatform.net"
  },
  "capabilities": {
    "customScheme": false,
    "httpsLikeAssetOrigin": true,
    "implicitBlobOriginSafe": false,
    "networkAllowed": false,
    "bundledAssetsOnly": true
  }
}
""".trimIndent()

    @Test
    fun `valid contract passes`() {
        val result = AndroidRuntimeOriginContract.validate(validContract.toByteArray())
        assertTrue("must be Valid, got: $result", result is AndroidRuntimeOriginContract.Result.Valid)
    }

    @Test
    fun `malformed JSON is rejected`() {
        val result = AndroidRuntimeOriginContract.validate("{not json".toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("Not valid JSON"))
    }

    @Test
    fun `malformed UTF-8 is rejected`() {
        val bytes = byteArrayOf(0x48, 0x65, 0x6C, 0x6C, 0x6F, 0xFF.toByte(), 0xFE.toByte())
        val result = AndroidRuntimeOriginContract.validate(bytes)
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }

    @Test
    fun `wrong schema is rejected`() {
        val contract = validContract.replace("fortweb.runtime-origin.v1", "wrong.schema.v2")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("schema"))
    }

    @Test
    fun `wrong version is rejected`() {
        val contract = validContract.replace("\"version\": 1", "\"version\": 99")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }

    @Test
    fun `wrong platform is rejected`() {
        val contract = validContract.replace("android-webview", "ios-wkwebview")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }

    @Test
    fun `wrong mode is rejected`() {
        val contract = validContract.replace("bundled-offline", "browser-dev")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }

    @Test
    fun `wrong documentOrigin is rejected`() {
        val contract = validContract.replace(
            "https://appassets.androidplatform.net",
            "https://evil.example.com"
        )
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        // The first occurrence is documentOrigin
        val inv = result as AndroidRuntimeOriginContract.Result.Invalid
        assertTrue(inv.reason.contains("documentOrigin"))
    }

    @Test
    fun `networkAllowed true is rejected`() {
        val contract = validContract.replace("\"networkAllowed\": false", "\"networkAllowed\": true")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("networkAllowed"))
    }

    @Test
    fun `bundledAssetsOnly false is rejected`() {
        val contract = validContract.replace("\"bundledAssetsOnly\": true", "\"bundledAssetsOnly\": false")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("bundledAssetsOnly"))
    }

    @Test
    fun `missing storage is rejected`() {
        val contract = validContract.replace(""""storage": {""", """"storageX": {""")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("storage"))
    }

    @Test
    fun `missing capabilities is rejected`() {
        val contract = validContract.replace(""""capabilities": {""", """"capabilitiesX": {""")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
        assertTrue((result as AndroidRuntimeOriginContract.Result.Invalid).reason.contains("capabilities"))
    }

    @Test
    fun `wrong entryUrl is rejected`() {
        val contract = validContract.replace(
            "app/index.html",
            "wrong/path.html"
        )
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }

    @Test
    fun `customScheme true is rejected`() {
        val contract = validContract.replace("\"customScheme\": false", "\"customScheme\": true")
        val result = AndroidRuntimeOriginContract.validate(contract.toByteArray())
        assertTrue("must be Invalid", result is AndroidRuntimeOriginContract.Result.Invalid)
    }
}

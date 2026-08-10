package org.kerifoundation.fortandroid

import org.json.JSONException
import org.json.JSONObject
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/**
 * Validates the Android-owned runtime-origin contract against FortWeb's
 * producer schema AND Android-specific trust-boundary invariants.
 *
 * Fail-closed: any defect prevents navigation to the canonical payload.
 */
internal object AndroidRuntimeOriginContract {

    private const val EXPECTED_SCHEMA = "fortweb.runtime-origin.v1"
    private const val EXPECTED_VERSION = 1
    private const val EXPECTED_PLATFORM = "android-webview"
    private const val EXPECTED_MODE = "bundled-offline"
    private const val TRUSTED_ORIGIN = "https://appassets.androidplatform.net"
    private const val TRUSTED_APP_BASE = "https://appassets.androidplatform.net/app/"
    private const val TRUSTED_ENTRY_URL = "https://appassets.androidplatform.net/app/index.html"
    private const val TRUSTED_WORKER_URL = "https://appassets.androidplatform.net/app/runtime/wallet-worker.py"
    private const val TRUSTED_CONFIG_URL = "https://appassets.androidplatform.net/pyscript-ci.toml"

    data class ValidatedContract(val jsonString: String) {
        val documentOrigin: String = TRUSTED_ORIGIN
        val entryUrl: String = TRUSTED_ENTRY_URL
    }

    sealed class Result {
        data class Valid(val contract: ValidatedContract) : Result()
        data class Invalid(val reason: String) : Result()
    }

    /**
     * Strict UTF-8 decode. Malformed/unmappable input fails closed.
     */
    private fun decodeStrictUtf8(bytes: ByteArray): String {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (e: CharacterCodingException) {
            throw IllegalArgumentException("Runtime origin contract is not valid UTF-8", e)
        }
    }

    fun validate(bytes: ByteArray): Result {
        val raw: String
        try {
            raw = decodeStrictUtf8(bytes)
        } catch (e: Exception) {
            return Result.Invalid("Not valid UTF-8: ${e.message}")
        }

        val root: JSONObject
        try {
            root = JSONObject(raw)
        } catch (e: JSONException) {
            return Result.Invalid("Not valid JSON: ${e.message}")
        }

        // ── Schema identity ──────────────────────────────────────────
        val schema = root.optString("schema", "")
        if (schema != EXPECTED_SCHEMA) return Result.Invalid("schema must be $EXPECTED_SCHEMA, got: $schema")

        val version = root.optInt("version", -1)
        if (version != EXPECTED_VERSION) return Result.Invalid("version must be $EXPECTED_VERSION, got: $version")

        val platform = root.optString("platform", "")
        if (platform != EXPECTED_PLATFORM) return Result.Invalid("platform must be $EXPECTED_PLATFORM, got: $platform")

        val mode = root.optString("mode", "")
        if (mode != EXPECTED_MODE) return Result.Invalid("mode must be $EXPECTED_MODE, got: $mode")

        // ── URL fields ───────────────────────────────────────────────
        val urlChecks = listOf(
            "documentOrigin" to TRUSTED_ORIGIN,
            "appBaseUrl" to TRUSTED_APP_BASE,
            "entryUrl" to TRUSTED_ENTRY_URL,
            "workerUrl" to TRUSTED_WORKER_URL,
            "configUrl" to TRUSTED_CONFIG_URL,
        )
        for ((field, expected) in urlChecks) {
            val value = root.optString(field, "")
            if (value != expected) return Result.Invalid("$field must be $expected, got: $value")
        }

        // All URLs must be under the trusted origin
        for ((field, _) in urlChecks) {
            val value = root.optString(field, "")
            if (!value.startsWith(TRUSTED_ORIGIN)) {
                return Result.Invalid("$field must start with $TRUSTED_ORIGIN, got: $value")
            }
        }

        // ── Storage ──────────────────────────────────────────────────
        val storage = root.optJSONObject("storage")
            ?: return Result.Invalid("storage object is required")

        val storageNamespace = storage.optString("storageNamespace", "")
        if (storageNamespace.isEmpty()) return Result.Invalid("storage.storageNamespace must be non-empty")

        val indexedDbRequired = storage.opt("indexedDbRequired")
        if (indexedDbRequired !is Boolean) return Result.Invalid("storage.indexedDbRequired must be boolean")
        if (indexedDbRequired != true) return Result.Invalid("storage.indexedDbRequired must be true")

        val originPartition = storage.optString("originPartition", "")
        if (originPartition != TRUSTED_ORIGIN) return Result.Invalid("storage.originPartition must be $TRUSTED_ORIGIN, got: $originPartition")

        // ── Capabilities ─────────────────────────────────────────────
        val capabilities = root.optJSONObject("capabilities")
            ?: return Result.Invalid("capabilities object is required")

        val capChecks = listOf(
            "customScheme" to false,
            "httpsLikeAssetOrigin" to true,
            "networkAllowed" to false,
            "bundledAssetsOnly" to true,
        )
        for ((field, expected) in capChecks) {
            val value = capabilities.opt(field)
            if (value !is Boolean) return Result.Invalid("capabilities.$field must be boolean")
            if (value != expected) return Result.Invalid("capabilities.$field must be $expected, got: $value")
        }

        val implicitBlobOriginSafe = capabilities.opt("implicitBlobOriginSafe")
        if (implicitBlobOriginSafe !is Boolean && implicitBlobOriginSafe != null) {
            return Result.Invalid("capabilities.implicitBlobOriginSafe must be boolean or absent")
        }
        if (implicitBlobOriginSafe == true) {
            return Result.Invalid("capabilities.implicitBlobOriginSafe must be false, got: true")
        }

        // ── Optional pyodide/wheels ──────────────────────────────────
        val pyodide = root.optJSONObject("pyodide")
        if (pyodide != null) {
            for (key in pyodide.keys()) {
                val url = pyodide.optString(key, "")
                if (url.isNotEmpty() && !url.startsWith(TRUSTED_ORIGIN)) {
                    return Result.Invalid("pyodide.$key must be under $TRUSTED_ORIGIN, got: $url")
                }
            }
        }

        val wheels = root.optJSONObject("wheels")
        if (wheels != null) {
            for (key in wheels.keys()) {
                val url = wheels.optString(key, "")
                if (url.isNotEmpty() && !url.startsWith(TRUSTED_ORIGIN)) {
                    return Result.Invalid("wheels.$key must be under $TRUSTED_ORIGIN, got: $url")
                }
            }
        }

        return Result.Valid(ValidatedContract(raw))
    }
}

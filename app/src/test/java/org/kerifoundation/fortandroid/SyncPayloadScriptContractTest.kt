package org.kerifoundation.fortandroid

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncPayloadScriptContractTest {

    @Test
    fun `sync payload script can fetch or stage the FortWeb payload`() {
        val script = Files.readString(locateSyncScript())

        assertTrue(
            "sync-payload.sh should still support a sibling FortWeb checkout",
            script.contains("DEFAULT_FORTWEB_DIR=\"${'$'}{SCRIPT_DIR}/../fortweb\"")
        )
        assertTrue(
            "sync-payload.sh should support fetch mode",
            script.contains("--fetch") &&
                script.contains("FORTWEB_REMOTE") &&
                script.contains("FORTWEB_REF")
        )
        assertTrue(
            "sync-payload.sh should pin the default fetch ref to the audited FortWeb commit",
            script.contains("FORTWEB_REF=\"${'$'}{FORTWEB_REF:-214643f4fa907061334c09c8297c4d1e59f18f45}\"")
        )
        assertTrue(
            "sync-payload.sh should fetch a commit, tag, or branch via git fetch in fetch mode",
            script.contains("git -C \"${'$'}{FORTWEB_SOURCE_DIR}\" fetch --depth 1 origin \"${'$'}{FORTWEB_REF}\"")
        )
        assertTrue(
            "sync-payload.sh should stage FortWeb app assets under the Android payload tree",
            script.contains("cp -R \"${'$'}{FORTWEB_SOURCE_DIR}/app\" \"${'$'}{WRAPPER_PAYLOAD_DIR}/fortweb/app\"")
        )
        assertTrue(
            "sync-payload.sh should stage FortWeb vendor assets under the Android payload tree",
            script.contains("cp -R \"${'$'}{FORTWEB_SOURCE_DIR}/vendor\" \"${'$'}{WRAPPER_PAYLOAD_DIR}/fortweb/vendor\"")
        )
        assertTrue(
            "sync-payload.sh should stage FortWeb wheels under the Android payload tree",
            script.contains("cp -R \"${'$'}{FORTWEB_SOURCE_DIR}/wheels\" \"${'$'}{WRAPPER_PAYLOAD_DIR}/fortweb/wheels\"")
        )
        assertTrue(
            "sync-payload.sh should write the FortWeb redirect root",
            script.contains("window.location.replace('./fortweb/app/index.html');")
        )
        assertTrue(
            "sync-payload.sh should generate the shared wrapper manifest",
            script.contains("--build-command './sync-payload.sh'")
        )
        assertTrue(
            "sync-payload.sh should validate the final Android payload",
            script.contains("--target android-asset-payload")
        )
        assertTrue(
            "sync-payload.sh should refresh the generated BridgeContract.kt",
            script.contains("cp \"${'$'}{BRIDGE_CONTRACT_SRC}\" \"${'$'}{BRIDGE_CONTRACT_DEST}\"")
        )
        assertTrue(
            "sync-payload.sh should verify the final manifest and bridge artifacts",
            script.contains("generated build-manifest.json") &&
                script.contains("synced BridgeContract.kt")
        )
        assertFalse(
            "sync-payload.sh should not retain the retired Fort-ios payload-source switch",
            script.contains("PAYLOAD_SOURCE") || script.contains("fort-ios)")
        )
    }

    private fun locateSyncScript(): Path {
        val candidatePaths = listOf(
            Paths.get(System.getProperty("user.dir"), "sync-payload.sh"),
            Paths.get(System.getProperty("user.dir"), "..", "sync-payload.sh")
        )

        return candidatePaths.firstOrNull { Files.isRegularFile(it) }
            ?: throw IllegalStateException(
                "Unable to locate sync-payload.sh from ${System.getProperty("user.dir")}"
            )
    }
}
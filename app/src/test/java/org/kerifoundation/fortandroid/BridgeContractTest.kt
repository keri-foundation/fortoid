package org.kerifoundation.fortandroid

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.kerifoundation.fort.bridge.BridgeContract

class BridgeContractTest {
    @Test
    fun bridgeMessageTypesIncludeDiagnostics() {
        assertTrue(BridgeContract.ALL_BRIDGE_MESSAGE_TYPES.contains(BridgeContract.BRIDGE_DIAGNOSTICS))
    }

    @Test
    fun workerResultTypesIncludeDiagnostics() {
        assertTrue(BridgeContract.ALL_WORKER_RESULT_TYPES.contains(BridgeContract.WORKER_RES_DIAGNOSTICS))
    }

    @Test
    fun lifecycleStatesRemainNonEmpty() {
        assertFalse(BridgeContract.ALL_LIFECYCLE_STATES.any { it.isBlank() })
    }
}
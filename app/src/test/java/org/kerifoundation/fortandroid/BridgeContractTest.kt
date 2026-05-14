package org.kerifoundation.fortandroid

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.kerifoundation.fort.bridge.BridgeContract

class BridgeContractTest {
    @Test
    fun bridgeMessageTypesMatchSharedContract() {
        assertTrue(BridgeContract.ALL_BRIDGE_MESSAGE_TYPES.contains(BridgeContract.BRIDGE_LIFECYCLE))
        assertTrue(BridgeContract.ALL_BRIDGE_MESSAGE_TYPES.contains(BridgeContract.BRIDGE_LOG))
        assertTrue(BridgeContract.ALL_BRIDGE_MESSAGE_TYPES.contains(BridgeContract.BRIDGE_CRYPTO_RESULT))
    }

    @Test
    fun workerResultTypesMatchSharedContract() {
        assertTrue(BridgeContract.ALL_WORKER_RESULT_TYPES.contains(BridgeContract.WORKER_RES_READY))
        assertTrue(BridgeContract.ALL_WORKER_RESULT_TYPES.contains(BridgeContract.WORKER_RES_BLAKE3_RESULT))
        assertTrue(BridgeContract.ALL_WORKER_RESULT_TYPES.contains(BridgeContract.WORKER_RES_ERROR))
    }

    @Test
    fun lifecycleStatesRemainNonEmpty() {
        assertFalse(BridgeContract.ALL_LIFECYCLE_STATES.any { it.isBlank() })
    }
}
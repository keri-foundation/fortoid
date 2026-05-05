package org.kerifoundation.fortandroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.kerifoundation.fort.bridge.BridgeContract

class BridgeContractTest {
    @Test
    fun bridgeMessageTypesMatchSharedContract() {
        assertEquals(
            setOf(
                BridgeContract.BRIDGE_JS_ERROR,
                BridgeContract.BRIDGE_UNHANDLED_REJECTION,
                BridgeContract.BRIDGE_LOG,
                BridgeContract.BRIDGE_LIFECYCLE,
                BridgeContract.BRIDGE_CRYPTO_RESULT,
            ),
            BridgeContract.ALL_BRIDGE_MESSAGE_TYPES.toSet(),
        )
    }

    @Test
    fun workerResultTypesMatchSharedContract() {
        assertEquals(
            setOf(
                BridgeContract.WORKER_RES_READY,
                BridgeContract.WORKER_RES_BLAKE3_RESULT,
                BridgeContract.WORKER_RES_SIGN_RESULT,
                BridgeContract.WORKER_RES_VERIFY_RESULT,
                BridgeContract.WORKER_RES_DB_SAVE_RESULT,
                BridgeContract.WORKER_RES_DB_LOAD_RESULT,
                BridgeContract.WORKER_RES_DB_DELETE_RESULT,
                BridgeContract.WORKER_RES_ERROR,
                BridgeContract.WORKER_RES_LOG,
            ),
            BridgeContract.ALL_WORKER_RESULT_TYPES.toSet(),
        )
    }

    @Test
    fun workerCommandTypesMatchSharedContract() {
        assertEquals(
            setOf(
                BridgeContract.WORKER_CMD_INIT,
                BridgeContract.WORKER_CMD_BLAKE3_HASH,
                BridgeContract.WORKER_CMD_SIGN,
                BridgeContract.WORKER_CMD_VERIFY,
                BridgeContract.WORKER_CMD_DB_SAVE,
                BridgeContract.WORKER_CMD_DB_LOAD,
                BridgeContract.WORKER_CMD_DB_DELETE,
            ),
            BridgeContract.ALL_WORKER_COMMAND_TYPES.toSet(),
        )
    }

    @Test
    fun lifecycleStatesRemainNonEmpty() {
        assertFalse(BridgeContract.ALL_LIFECYCLE_STATES.any { it.isBlank() })
    }
}
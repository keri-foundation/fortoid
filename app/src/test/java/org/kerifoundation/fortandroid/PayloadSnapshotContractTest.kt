package org.kerifoundation.fortandroid

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.junit.Assert.assertTrue
import org.junit.Test

class PayloadSnapshotContractTest {

    @Test
    fun `repo ships a bundled payload-missing placeholder`() {
        val placeholder = locateAssetsRoot().resolve("bootstrap/payload-missing.html")

        assertTrue("payload-missing placeholder should exist", Files.isRegularFile(placeholder))

        val placeholderHtml = Files.readString(placeholder)
        assertTrue(
            "placeholder should tell developers how to fetch the payload",
            Regex("""\.\/sync-payload\.sh --fetch --ref [0-9a-f]{40}""").containsMatchIn(placeholderHtml)
        )
        assertTrue(
            "placeholder should explain where the generated payload is written",
            placeholderHtml.contains("app/src/main/assets/payload/")
        )
    }

    private fun locateAssetsRoot(): Path {
        val candidateRoots = listOf(
            Paths.get(System.getProperty("user.dir"), "app", "src", "main", "assets"),
            Paths.get(System.getProperty("user.dir"), "src", "main", "assets")
        )

        return candidateRoots.firstOrNull { Files.isDirectory(it) }
            ?: throw IllegalStateException(
                "Unable to locate app/src/main/assets from ${System.getProperty("user.dir")}"
            )
    }
}
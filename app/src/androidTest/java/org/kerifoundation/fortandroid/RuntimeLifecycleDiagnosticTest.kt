package org.kerifoundation.fortandroid

import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.File
import java.security.MessageDigest
import android.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class RuntimeLifecycleDiagnosticTest {
    private fun waitForStartup(deadline: Long) {
        while (SystemClock.elapsedRealtime() < deadline) {
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "logcat -d -v brief --pid=${android.os.Process.myPid()} -s FortAndroid:V"
            )
            val log = descriptor.use { FileInputStream(it.fileDescriptor).bufferedReader().use { reader -> reader.readText() } }
            if (log.lineSequence().any {
                    it.contains("event=request_end") && it.contains("method=\"vaults.list\"") && it.contains("outcome=\"ok\"")
                }) return
            Thread.sleep(500)
        }
        error("application startup vault listing did not complete")
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String? {
        val result = AtomicReference<String?>()
        val latch = CountDownLatch(1)
        scenario.onActivity { activity ->
            val field = MainActivity::class.java.getDeclaredField("webView")
            field.isAccessible = true
            (field.get(activity) as WebView).evaluateJavascript(script) {
                result.set(it)
                latch.countDown()
            }
        }
        assertTrue("JavaScript callback timed out", latch.await(10, TimeUnit.SECONDS))
        return result.get()
    }

    @Test
    fun syntheticCredentialLifecycle() {
        val arguments = InstrumentationRegistry.getArguments()
        val expectedPhase = arguments.getString("phase") ?: "write"
        assumeTrue("synthetic lifecycle requires an explicit runId", arguments.getString("runId") != null)
        val runId = requireNotNull(arguments.getString("runId")) { "runId is required" }
        require(runId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "Invalid runId" }
        require(expectedPhase in setOf("write", "read")) { "Invalid phase" }
        val checkpointFile = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
            "sedi-lifecycle-checkpoint-$runId.json")
        val checkpoint = if (expectedPhase == "read") {
            require(checkpointFile.isFile) { "Synthetic checkpoint is missing" }
            JSONObject(checkpointFile.readText())
        } else {
            require(!checkpointFile.exists()) { "Synthetic checkpoint already exists" }
            JSONObject()
        }
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets
            .open("sedi-lifecycle-diagnostic.js").bufferedReader().use { it.readText() }
            .replace("__PROCESS_ID__", android.os.Process.myPid().toString())
            .replace("__CHECKPOINT_JSON__", checkpoint.toString())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun evaluate(script: String) = evaluate(scenario, script)
            val deadline = SystemClock.elapsedRealtime() + 420_000
            while (SystemClock.elapsedRealtime() < deadline &&
                evaluate("location.href") != "\"https://appassets.androidplatform.net/app/index.html\"") {
                Thread.sleep(500)
            }
            assertEquals("\"https://appassets.androidplatform.net/app/index.html\"", evaluate("location.href"))
            waitForStartup(deadline)
            evaluate(fixture)
            var outcome = JSONObject()
            var lastStage = ""
            while (SystemClock.elapsedRealtime() < deadline) {
                val stage = evaluate("window.__sediLifecycleStage") ?: "null"
                if (stage != lastStage) {
                    Log.i("SediLifecycleDiagnostic", "stage=$stage")
                    lastStage = stage
                }
                val raw = evaluate("JSON.stringify(window.__sediLifecycleResult)")
                if (raw != null && raw != "null") {
                    outcome = JSONObject(JSONTokener(raw).nextValue() as String)
                    break
                }
                Thread.sleep(1000)
            }
            Log.i("SediLifecycleDiagnostic", "outcome=$outcome")
            assertTrue("lifecycle did not complete: $outcome", outcome.optBoolean("ok"))
            assertEquals(expectedPhase, outcome.optString("phase"))
            if (expectedPhase == "write") {
                val raw = requireNotNull(evaluate("JSON.stringify(window.__sediLifecycleCheckpoint)"))
                val saved = JSONObject(JSONTokener(raw).nextValue() as String)
                assertEquals(android.os.Process.myPid(), saved.getInt("processId"))
                assertTrue("synthetic checkpoint already exists", checkpointFile.createNewFile())
                FileOutputStream(checkpointFile).use { stream ->
                    stream.write(saved.toString().toByteArray(Charsets.UTF_8))
                    stream.fd.sync()
                }
            }
        }
    }

    @Test
    fun syntheticCoreSediPresentation() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("synthetic Core test requires an explicit runId", args.getString("runId") != null)
        val runId = requireNotNull(args.getString("runId"))
        require(runId.matches(Regex("[A-Za-z0-9_-]{1,64}")))
        val phase = args.getString("phase") ?: "write"
        require(phase in setOf("write", "read")) { "Invalid Core phase" }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val expectedPackage = requireNotNull(args.getString("expectedPackage"))
        require(expectedPackage in setOf("org.kerifoundation.fortandroid", "org.kerifoundation.fortandroid.seditest"))
        assertEquals("unexpected test app", expectedPackage, context.packageName)
        val manifestBytes = context.assets.open("payload/manifest.json").use { it.readBytes() }
        fun digest(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data)
            .joinToString("") { "%02x".format(it) }
        assertEquals(requireNotNull(args.getString("manifestSha256")), digest(manifestBytes))
        val manifest = JSONObject(String(manifestBytes, Charsets.UTF_8))
        assertEquals(requireNotNull(args.getString("fortwebCommit")), manifest.getString("fortweb_commit_sha"))
        val files = manifest.getJSONArray("files")
        assertEquals(160, files.length())
        for (index in 0 until files.length()) {
            val item = files.getJSONObject(index)
            val bytes = context.assets.open("payload/" + item.getString("path")).use { it.readBytes() }
            assertEquals(item.getString("sha256"), digest(bytes))
        }
        val directory = File(context.filesDir, "sedi-core-$runId")
        val checkpointFile = File(directory, "core-checkpoint.json")
        val checkpoint = if (phase == "read") {
            require(checkpointFile.isFile) { "Core checkpoint is missing" }
            JSONObject(checkpointFile.readText()).also {
                require(it.getString("runId") == runId && it.getString("manifestSha256") == digest(manifestBytes))
                require(it.getInt("processId") != android.os.Process.myPid()) { "Core process did not restart" }
                require(!File(directory, "process-recovered.json").exists()) { "Core recovery already recorded" }
            }
        } else {
            assertTrue("test directory already exists", directory.mkdir())
            null
        }
        fun save(name: String, text: String) {
            val temp = File(directory, "$name.tmp")
            temp.writeText(text)
            assertTrue("could not publish $name", temp.renameTo(File(directory, name)))
        }
        fun awaitFile(name: String): String {
            val file = File(directory, name)
            repeat(6000) {
                if (file.isFile) return file.readText()
                Thread.sleep(100)
            }
            error("Timed out waiting for $name")
        }
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets
            .open("sedi-core-diagnostic.js").bufferedReader().use { it.readText() }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun eval(script: String) = evaluate(scenario, script)
            val deadline = SystemClock.elapsedRealtime() + 180_000
            while (SystemClock.elapsedRealtime() < deadline &&
                eval("location.href") != "\"https://appassets.androidplatform.net/app/index.html\"") {
                Thread.sleep(500)
            }
            assertEquals("\"https://appassets.androidplatform.net/app/index.html\"", eval("location.href"))
            waitForStartup(deadline)
            eval(fixture)
            fun action(name: String, input: String): String {
                eval("window.__sediCoreRun(${JSONObject.quote(name)}, ${JSONObject.quote(input)})")
                repeat(1800) {
                    val raw = eval("JSON.stringify(window.__sediCoreResult)")
                    if (raw != null && raw != "null") {
                        val decoded = JSONTokener(raw).nextValue()
                        if (decoded is String && decoded != "null") {
                            val value = JSONObject(decoded)
                            assertTrue("$name failed: $value", value.optBoolean("ok"))
                            return value.getString("value")
                        }
                    }
                    Thread.sleep(100)
                }
                error("Timed out during $name")
            }
            if (phase == "read") {
                val recovered = JSONObject(action("resume", requireNotNull(checkpoint).getJSONObject("data").toString()))
                assertTrue("Core recovery failed", recovered.optBoolean("recovered"))
                assertTrue("missing credential was not rejected", recovered.optBoolean("missingCredentialRejected"))
                assertTrue("mismatched binding was not rejected", recovered.optBoolean("mismatchedBindingRejected"))
                recovered.put("processId", android.os.Process.myPid())
                save("process-recovered.json", recovered.toString())
                return@use
            }
            save("holder.json", action("setup", runId))
            val ready = action("prepare", awaitFile("fixture.json"))
            val prepared = JSONObject(ready)
            assertTrue("preflight failed: $ready", prepared.optBoolean("invalidRejected"))
            assertTrue("holder KEL changed", prepared.optBoolean("holderKelUnchanged"))
            assertTrue("registry view changed", prepared.optBoolean("registryViewUnchanged"))
            save("ready.json", ready)
            awaitFile("go.json")
            val presentation = action("present", "")
            val encoded = JSONObject(presentation).getJSONObject("exchange").getString("cesr")
            save("grant-cesr.sha256", digest(Base64.decode(encoded, Base64.DEFAULT)))
            save("grant-timing.json", JSONObject().put("wallSeconds", System.currentTimeMillis() / 1000.0).toString())
            save("fortweb-presentation.json", presentation)
            save("recovered.json", action("recover", ""))
            val native = JSONObject(awaitFile("native-result.json"))
            for (key in listOf("valid", "wrong", "missing", "missingAgent", "missingProof")) {
                assertTrue("native verifier did not pass $key", native.optBoolean(key))
            }
            val data = JSONObject(action("checkpoint", ""))
            val saved = JSONObject().put("runId", runId).put("manifestSha256", digest(manifestBytes))
                .put("processId", android.os.Process.myPid()).put("data", data)
            assertTrue("Core checkpoint already exists", checkpointFile.createNewFile())
            FileOutputStream(checkpointFile).use { stream ->
                stream.write(saved.toString().toByteArray(Charsets.UTF_8))
                stream.fd.sync()
            }
        }
    }
}

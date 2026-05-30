package org.kerifoundation.fortandroid

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class MainActivityWebViewSmokeTest {
    @get:Rule
    val activityRule = ActivityScenarioRule(MainActivity::class.java)

    private val device: UiDevice = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @Test
    fun appLaunchesStableShellChrome() {
        assertTextContains("Locksmith shell ready", "Expected shell to reach ready state")
        assertTextVisible("Home", "Expected home tab to appear")
        assertTextVisible("Vault", "Expected vault tab to appear")
        assertTextVisible("Settings", "Expected settings tab to appear")
        assertTextVisible("Open Vault", "Expected primary vault action to appear")
    }

    @Test
    fun settingsTabShowsDiagnosticsPanel() {
        assertTextVisible("Settings", "Expected settings tab button to appear")
        device.findObject(By.text("Settings"))?.click()
        assertTextVisible(
            "Worker diagnostics",
            "Expected diagnostics panel to appear in settings"
        )
    }

    @Test
    fun appBootsToVaultPickerScreen() {
        assertTrue(
            "Expected vault picker to render",
            device.wait(Until.hasObject(By.textContains("Your Vaults")), BOOT_TIMEOUT_MS)
        )
    }

    @Test
    fun settingsTabShowsDangerZoneInsideOpenVault() {
        createAndOpenVault()

        device.findObject(By.text("Settings"))?.click()

        assertTrue(
            "Expected danger zone section to appear in settings",
            device.wait(Until.hasObject(By.text("Danger Zone")), DEFAULT_TIMEOUT_MS)
        )
    }

    @Test
    fun keyboardAppearsWhenInputFieldTapped() {
        assertTrue(
            "Expected vault picker to render before creating vault",
            device.wait(Until.hasObject(By.textContains("Your Vaults")), BOOT_TIMEOUT_MS)
        )

        val createButton = device.findObject(By.textContains("Create"))
            ?: device.findObject(By.textContains("Add"))
        assertNotNull("Expected a Create or Add button on vault picker", createButton)
        createButton.click()

        assertTrue(
            "Expected vault creation dialog to appear",
            device.wait(Until.hasObject(By.textContains("Name")), DEFAULT_TIMEOUT_MS)
        )

        val nameField = device.findObject(By.textContains("Name"))
        assertNotNull("Expected Name input field in dialog", nameField)
        nameField.click()

        assertTrue(
            "Expected soft keyboard to be visible after tapping input field",
            waitForImeVisibility(expectedVisible = true, timeoutMs = KEYBOARD_VISIBILITY_TIMEOUT_MS)
        )

        device.pressBack()

        assertTrue(
            "Expected soft keyboard to be hidden after pressing back",
            waitForImeVisibility(expectedVisible = false, timeoutMs = KEYBOARD_VISIBILITY_TIMEOUT_MS)
        )
    }

    private fun waitForImeVisibility(expectedVisible: Boolean, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        do {
            if (isImeVisible() == expectedVisible) {
                return true
            }
            device.waitForIdle(KEYBOARD_POLL_INTERVAL_MS)
        } while (System.currentTimeMillis() < deadline)

        return isImeVisible() == expectedVisible
    }

    private fun assertTextVisible(text: String, failureMessage: String) {
        assertTrue(failureMessage, device.wait(Until.hasObject(By.text(text)), DEFAULT_TIMEOUT_MS))
    }

    private fun assertTextContains(text: String, failureMessage: String) {
        assertTrue(
            failureMessage,
            device.wait(Until.hasObject(By.textContains(text)), DEFAULT_TIMEOUT_MS)
        )
    }

    private fun isImeVisible(): Boolean {
        var keyboardVisible = false
        activityRule.scenario.onActivity { activity ->
            val rootView = activity.findViewById<android.view.View>(R.id.main)
            val insets = ViewCompat.getRootWindowInsets(rootView)
            keyboardVisible = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        return keyboardVisible
    }

    private fun createAndOpenVault() {
        val alias = "ui-smoke-${System.currentTimeMillis()}"
        val passcode = "123456"

        assertTrue(
            "Expected vault picker to render before creating a vault",
            device.wait(Until.hasObject(By.textContains("Your Vaults")), BOOT_TIMEOUT_MS)
        )

        val createButton = device.findObject(By.text("Create Vault"))
            ?: device.findObject(By.textContains("Create"))
        assertNotNull("Expected a Create Vault action on the home screen", createButton)
        createButton.click()

        assertTrue(
            "Expected vault creation dialog to appear",
            device.wait(Until.hasObject(By.textContains("Name")), DEFAULT_TIMEOUT_MS)
        )

        val nameField = device.findObject(By.textContains("Name"))
        val passcodeField = device.findObject(By.textContains("Passcode"))
        val submitButton = device.findObject(By.text("Create"))

        assertNotNull("Expected Name field in vault creation dialog", nameField)
        assertNotNull("Expected Passcode field in vault creation dialog", passcodeField)
        assertNotNull("Expected Create button in vault creation dialog", submitButton)

        nameField.text = alias
        passcodeField.text = passcode
        submitButton.click()

        assertTrue(
            "Expected unlock screen or vault shell after vault creation",
            waitForEitherText(firstText = "Open", secondText = "Settings", timeoutMs = BOOT_TIMEOUT_MS)
        )

        val unlockPasscodeField = device.findObject(By.textContains("Passcode"))
        val openButton = device.findObject(By.text("Open"))

        if (unlockPasscodeField != null && openButton != null) {
            unlockPasscodeField.text = passcode
            openButton.click()
        }

        assertTrue(
            "Expected vault shell to render after opening vault",
            device.wait(Until.hasObject(By.text("Settings")), DEFAULT_TIMEOUT_MS)
        )
    }

    private fun waitForEitherText(firstText: String, secondText: String, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        do {
            if (device.hasObject(By.text(firstText)) || device.hasObject(By.text(secondText))) {
                return true
            }

            val remainingMs = deadline - System.currentTimeMillis()
            if (remainingMs <= 0L) {
                break
            }

            device.waitForIdle(minOf(UI_POLL_INTERVAL_MS, remainingMs))
        } while (System.currentTimeMillis() < deadline)

        return device.hasObject(By.text(firstText)) || device.hasObject(By.text(secondText))
    }

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 20_000L
        const val BOOT_TIMEOUT_MS = 60_000L
        const val UI_POLL_INTERVAL_MS = 100L
        const val KEYBOARD_VISIBILITY_TIMEOUT_MS = 5_000L
        const val KEYBOARD_POLL_INTERVAL_MS = 100L
    }
}
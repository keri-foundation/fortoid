package org.kerifoundation.fortandroid

import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
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
    fun appBootsToReadyStatusInsideWebView() {
        assertTrue(
            "Expected shell to reach ready state",
            device.wait(Until.hasObject(By.textContains("Locksmith shell ready")), DEFAULT_TIMEOUT_MS)
        )
    }

    @Test
    fun settingsTabShowsDiagnosticsPanel() {
        assertTrue(
            "Expected settings tab button to appear",
            device.wait(Until.hasObject(By.text("Settings")), DEFAULT_TIMEOUT_MS)
        )

        device.findObject(By.text("Settings"))?.click()

        assertTrue(
            "Expected diagnostics panel to appear in settings",
            device.wait(Until.hasObject(By.text("Worker diagnostics")), DEFAULT_TIMEOUT_MS)
        )
    }

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 20_000L
    }
}
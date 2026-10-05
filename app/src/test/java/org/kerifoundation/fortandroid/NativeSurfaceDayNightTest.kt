package org.kerifoundation.fortandroid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Contract for Android-owned native surfaces under day/night mode.
 *
 * The night theme used to be overridden by native code: the root layout forced
 * `@color/keri_window_light`, the WebView was created with a hardcoded
 * `#F7F8F4`, and the error view used `@android:color/black`. Those surfaces are
 * visible during activity startup, document boot, renderer recreation, and
 * payload failure, so night mode could still expose the light palette.
 *
 * These cases pin the replacement rule: every Android-owned surface resolves a
 * semantic resource name whose value is chosen by the configuration qualifier.
 * They are resource and source contract checks, not rendering checks; they
 * cannot prove what a device draws, only that a light-only native surface
 * cannot be reintroduced silently.
 */
class NativeSurfaceDayNightTest {

    private val appModuleDir = resolveAppModuleDir()

    private fun resolveAppModuleDir(): File {
        val start = File(System.getProperty("user.dir") ?: ".").absoluteFile
        var candidate: File? = start
        while (candidate != null) {
            if (File(candidate, "src/main/res/layout/activity_main.xml").isFile) {
                return candidate
            }
            if (File(candidate, "app/src/main/res/layout/activity_main.xml").isFile) {
                return File(candidate, "app")
            }
            candidate = candidate.parentFile
        }
        throw AssertionError("Could not locate the app module from $start")
    }

    private fun res(path: String) = File(appModuleDir, "src/main/res/$path")

    private val layout = res("layout/activity_main.xml").readText()
    private val lightColors = res("values/colors.xml").readText()
    private val nightColorsFile = res("values-night/colors.xml")
    private val lightTheme = res("values/themes.xml").readText()
    private val nightTheme = res("values-night/themes.xml").readText()
    private val mainActivity = File(
        appModuleDir,
        "src/main/java/org/kerifoundation/fortandroid/MainActivity.kt",
    ).readText()

    private fun colorDefinition(xml: String, name: String): String? =
        Regex("""<color\s+name="$name"\s*>\s*([^<\s]+)\s*</color>""")
            .find(xml)
            ?.groupValues
            ?.get(1)

    // --- Configuration-qualified definitions --------------------------------

    @Test
    fun `night qualifier overrides the semantic window surface`() {
        assertTrue(
            "values-night/colors.xml must override the semantic surface",
            nightColorsFile.isFile,
        )

        val nightColors = nightColorsFile.readText()

        assertEquals(
            "@color/keri_window_light",
            colorDefinition(lightColors, "keri_window_surface"),
        )
        assertEquals(
            "@color/keri_window_dark",
            colorDefinition(nightColors, "keri_window_surface"),
        )
    }

    @Test
    fun `window background is selected by the configuration qualifier`() {
        val windowBackground = """<item name="android:windowBackground">@color/keri_window_surface</item>"""

        assertTrue(
            "light theme must use the semantic window surface",
            lightTheme.contains(windowBackground),
        )
        assertTrue(
            "night theme must use the same semantic window surface",
            nightTheme.contains(windowBackground),
        )
    }

    // --- Root layout --------------------------------------------------------

    @Test
    fun `root layout no longer forces a mode-specific window palette`() {
        assertTrue(
            "root layout must use the semantic window surface",
            layout.contains("""android:background="@color/keri_window_surface""""),
        )
        assertFalse(
            "root layout must not force the light window palette",
            layout.contains("@color/keri_window_light"),
        )
        assertFalse(
            "root layout must not force the dark window palette either",
            layout.contains("@color/keri_window_dark"),
        )
    }

    // --- Error surface ------------------------------------------------------

    @Test
    fun `error view foreground stays legible in both modes`() {
        val nightColors = nightColorsFile.readText()

        assertTrue(
            "error view must use the semantic foreground",
            layout.contains("""android:textColor="@color/keri_on_window_surface""""),
        )
        assertFalse(
            "error view must not hardcode a mode-invariant system foreground",
            layout.contains("@android:color/black") || layout.contains("@android:color/white"),
        )
        assertEquals(
            "@color/keri_black",
            colorDefinition(lightColors, "keri_on_window_surface"),
        )
        assertEquals(
            "@color/keri_cream",
            colorDefinition(nightColors, "keri_on_window_surface"),
        )
    }

    // --- Kotlin surface -----------------------------------------------------

    @Test
    fun `webview background resolves the semantic surface without a light literal`() {
        assertTrue(
            "WebView must resolve the semantic window surface resource",
            mainActivity.contains("getColor(R.color.keri_window_surface)"),
        )
        assertFalse(
            "WebView must not hardcode the light window literal",
            mainActivity.contains("#F7F8F4"),
        )
        assertFalse(
            "WebView must not hardcode the dark window literal",
            mainActivity.contains("#0D0D0F"),
        )
        assertFalse(
            "WebView must not parse a colour literal for its background",
            mainActivity.contains("Color.parseColor"),
        )
    }

    // --- Whole-resource sweeps ---------------------------------------------

    @Test
    fun `mode-specific window palette is referenced only by its color resources`() {
        val colorResources = setOf(
            res("values/colors.xml").path,
            res("values-night/colors.xml").path,
        )
        val paletteNames = listOf("keri_window_light", "keri_window_dark")
        val offenders = mutableListOf<String>()

        res("").walkTopDown()
            .filter { it.isFile && it.extension == "xml" }
            .forEach { file ->
                if (file.path in colorResources) return@forEach
                if (paletteNames.any { file.readText().contains(it) }) {
                    offenders += file.path.removePrefix(appModuleDir.path)
                }
            }

        assertTrue(
            "native resources must name the semantic surface, not a mode-specific one: $offenders",
            offenders.isEmpty(),
        )
    }

    @Test
    fun `no native resource hardcodes a mode-invariant system foreground`() {
        val systemColors = listOf("@android:color/black", "@android:color/white")
        val offenders = mutableListOf<String>()

        res("").walkTopDown()
            .filter { it.isFile && it.extension == "xml" }
            .forEach { file ->
                if (systemColors.any { file.readText().contains(it) }) {
                    offenders += file.path.removePrefix(appModuleDir.path)
                }
            }

        assertTrue(
            "native resources must use a day/night-aware foreground: $offenders",
            offenders.isEmpty(),
        )
    }
}

// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    id("org.owasp.dependencycheck") version "12.1.0"
}

dependencyCheck {
    scanProjects = listOf(":app")
    formats = listOf("HTML")
    failBuildOnCVSS = 7.0F
}
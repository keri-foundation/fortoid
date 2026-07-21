plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "org.kerifoundation.fortandroid"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "org.kerifoundation.fortandroid"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.webkit)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

// ── Prepared-payload verification ────────────────────────────────────────────
// Fails when the canonical FortWeb runtime has not been staged.
// Unprepared Android Studio launches may use the placeholder; validated
// Gradle builds require a real payload.

tasks.register("verifyPreparedPayload") {
    description = "Verify the staged FortWeb runtime payload is present and valid"
    group = "verification"

    doLast {
        val payloadDir = file("src/main/assets/payload")
        val manifestFile = file("src/main/assets/payload/android-payload-manifest.json")
        val entryHtml = file("src/main/assets/payload/fortweb/app/index.html")
        val mainJs = file("src/main/assets/payload/fortweb/app/app/main.js")
        val originContract = file("src/main/assets/payload/fortweb/app/runtime-origin-contract.json")

        if (!payloadDir.exists()) {
            throw GradleException(
                "Payload directory missing. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        if (!manifestFile.exists()) {
            throw GradleException(
                "android-payload-manifest.json missing. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        if (!entryHtml.exists() || !mainJs.exists() || !originContract.exists()) {
            throw GradleException(
                "FortWeb runtime incomplete. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        // Verify node-based validator passes
        val validator = file("${project.rootDir}/tools/validate-staged-payload.mjs")
        if (validator.exists()) {
            val result = providers.exec {
                commandLine("node", validator.absolutePath)
                isIgnoreExitValue = true
            }
            val exitCode = result.result.get().exitValue
            if (exitCode != 0) {
                throw GradleException(
                    "Payload validation failed. See output above."
                )
            }
        }

        logger.lifecycle("verifyPreparedPayload: payload valid")
    }
}

// Wire into assembleDebug but not Android Studio sync
tasks.matching { it.name == "assembleDebug" }.configureEach {
    dependsOn("verifyPreparedPayload")
}
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
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.uiautomator)
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
        val manifestFile = file("src/main/assets/payload/manifest.json")
        val entryHtml = file("src/main/assets/payload/app/index.html")
        val mainJs = file("src/main/assets/payload/app/app/main.js")
        val requirementsContract = file("src/main/assets/payload/contracts/runtime-requirements.json")

        if (!payloadDir.exists()) {
            throw GradleException(
                "Payload directory missing. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        if (!manifestFile.exists()) {
            throw GradleException(
                "manifest.json missing. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        if (!entryHtml.exists() || !mainJs.exists() || !requirementsContract.exists()) {
            throw GradleException(
                "FortWeb runtime incomplete. Run: ./sync-payload.sh --fortweb-dir <path>"
            )
        }

        logger.lifecycle("verifyPreparedPayload: payload valid (run 'node tools/validate-staged-payload.mjs' for full validation)")
    }
}

// Wire into assembleDebug but not Android Studio sync
tasks.matching { it.name == "assembleDebug" }.configureEach {
    dependsOn("verifyPreparedPayload")
}
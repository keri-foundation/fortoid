# KERI Wallet For Android

KERI Wallet for Android is a thin native shell around the shared wallet web payload.
The Android app owns packaging, lifecycle, WebView security policy, and a narrow native bridge.
The shared payload owns wallet UI, routing, storage semantics, and Pyodide-backed KERI runtime behavior.

## What This Repo Contains

- A conventional single-module Android app under [app/](app/)
- The native host activity in [app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt](app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt)
- The committed shared payload snapshot in [app/src/main/assets/payload/](app/src/main/assets/payload/)
- The generated Kotlin bridge constants in [app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt)
- The payload refresh helper in [sync-payload.sh](sync-payload.sh)

## Architecture Summary

The Android lane is intentionally small and boring.

1. [MainActivity.kt](app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt) creates a single `WebView` and loads the app-owned payload from `https://appassets.androidplatform.net/assets/payload/index.html`.
2. [WebViewAssetLoader](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader) serves the committed assets from [app/src/main/assets/payload/](app/src/main/assets/payload/) under an HTTPS origin instead of `file://`.
3. The JS-to-Android bridge uses `WebViewCompat.addWebMessageListener(...)` and the injected `window.bridge` object; Android does not use `addJavascriptInterface(...)`.
4. Bridge message names and worker command/result constants come from the generated [BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt) file so Android stays aligned with the shared TypeScript contract.
5. The Android host may send a bounded smoke-test command after the payload reaches `ready` to prove the host -> web -> worker -> host path is alive, but product logic remains in the shared payload.

## Build And Run

Normal Android development is self-contained.
You do not need a sibling `Fort-ios` checkout just to clone this repo, open it in Android Studio, and run the app.

Current baseline:

- Android Studio stable
- Kotlin + Gradle Kotlin DSL
- Min SDK 28
- Target SDK 36
- Default emulator: Pixel 9 Pro, Android 16 / API 36.1, Google Play image

Repeatable CLI validation:

```sh
./gradlew :app:assembleDebug
./gradlew :app:installDebug
./gradlew :app:lint
```

Android Studio is useful for SDK management, sync, AVD setup, and debugger attach, but the Gradle CLI is the canonical validation path.

## Shared Payload Refresh

The current bundled wallet UI and Pyodide runtime originate from the active shared web lane in the sibling `Fort-ios` workspace repo.
That dependency exists only when you intentionally refresh the committed Android payload snapshot.

Refresh flow:

```sh
./sync-payload.sh
```

What [sync-payload.sh](sync-payload.sh) does:

1. Calls the shared payload builder in the sibling `Fort-ios` repo
2. Replaces the committed Android payload snapshot under [app/src/main/assets/payload/](app/src/main/assets/payload/)
3. Copies the generated Kotlin bridge contract into [app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt)
4. Verifies that `index.html`, `build-manifest.json`, and the generated bridge contract are present

If the sibling `Fort-ios` checkout is missing, Android builds still work with the checked-in payload snapshot already in this repo.

## Security Posture

The Android shell is locked down around app-owned content.

- Asset loading uses `WebViewAssetLoader` under `https://appassets.androidplatform.net/...`
- Navigation is deny-by-default and only the trusted app asset origin is allowed in-WebView
- Off-origin HTTPS navigation is handed off to Android intents instead of broadening the allowlist
- `addJavascriptInterface(...)` is forbidden
- SSL errors are canceled, not bypassed
- Safe Browsing remains enabled
- The `WebView` disables file/content access and file-URL privilege escalation flags
- Renderer loss is handled with bounded recovery through `onRenderProcessGone(...)`
- Web contents debugging is enabled only when the app itself is debuggable

Low-friction security checks already fit this repo well:

- `./gradlew :app:lint` for Android's built-in static checks on manifest, WebView, and platform API usage
- `./gradlew dependencyCheckAnalyze` as an optional, slower OWASP dependency audit when you explicitly want a vulnerability report

The intended workflow is to keep wrapper-specific hardening in Kotlin and use `:app:lint` as the fast default.
The OWASP dependency audit should run on demand or on a scheduled CI lane because the first update can take a long time without an NVD API key.

## Native Branding Scope

The native Android shell only owns thin platform surfaces:

- Launcher icon
- App label
- Native error state copy
- Theme colors and base window background

The wallet UI itself continues to come from the shared payload, not from a separate native Android implementation.

## Repository Layout

- [app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt](app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt): WebView host, navigation policy, bridge listener, renderer recovery
- [app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt): generated bridge constants shared with the TypeScript runtime
- [app/src/main/assets/payload/](app/src/main/assets/payload/): committed shared web payload snapshot used at runtime
- [app/src/main/res/](app/src/main/res/): launcher icon, theme, layout, and string resources
- [sync-payload.sh](sync-payload.sh): refresh the Android-bundled payload from the shared workspace lane
- [app/build.gradle.kts](app/build.gradle.kts): app module config
- [gradle/libs.versions.toml](gradle/libs.versions.toml): dependency versions including `androidx.webkit`

## Troubleshooting

### WebView unsupported message

If the app shows the secure bridge support error, the current WebView implementation does not support the message-listener bridge required by this wrapper.
That is treated as an unsupported runtime, not as a reason to fall back to a weaker bridge.

### Payload refresh fails

If `./sync-payload.sh` fails because the sibling `Fort-ios` checkout is missing, that only blocks payload refresh work.
It does not block normal Android builds that use the committed snapshot already in this repo.

### Node version warnings during payload refresh

The shared payload builder may warn if the local Node version does not match the shared web lane's pinned engine.
That warning comes from the payload refresh workflow, not from Android runtime behavior.

### Renderer failure message

The shell performs one bounded renderer recovery attempt.
If the renderer dies again after recovery, the app shows a native failure message instead of looping indefinitely.

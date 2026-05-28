# KERI Wallet For Android

KERI Wallet for Android is a thin native shell around the shared wallet web payload.
The Android app owns packaging, lifecycle, WebView security policy, and a narrow native bridge.
The shared payload owns wallet UI, routing, storage semantics, and Pyodide-backed KERI runtime behavior.

## What This Repo Contains

- A conventional single-module Android app under [app/](app/)
- The native host activity in [app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt](app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt)
- The bundled missing-payload placeholder in [app/src/main/assets/bootstrap/payload-missing.html](app/src/main/assets/bootstrap/payload-missing.html)
- The generated local payload output directory in [app/src/main/assets/payload/](app/src/main/assets/payload/)
- The generated Kotlin bridge constants in [app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt)
- The payload refresh helper in [sync-payload.sh](sync-payload.sh)

## Architecture Summary

The Android lane is intentionally small and boring.

1. [MainActivity.kt](app/src/main/java/org/kerifoundation/fortandroid/MainActivity.kt) creates a single `WebView` and loads the app-owned payload from `https://appassets.androidplatform.net/index.html`.
2. [WebViewAssetLoader](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader) serves the generated assets from [app/src/main/assets/payload/](app/src/main/assets/payload/) under an HTTPS origin instead of `file://` and falls back to a local placeholder page until the payload is generated.
3. The JS-to-Android bridge uses `WebViewCompat.addWebMessageListener(...)` and the injected `window.bridge` object; Android does not use `addJavascriptInterface(...)`.
4. Bridge message names and worker command/result constants come from the generated [BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt) file so Android stays aligned with the shared TypeScript contract.
5. The Android host may send a bounded smoke-test command after the payload reaches `ready` to prove the host -> web -> worker -> host path is alive, but product logic remains in the shared payload.

## Build And Run

This repo no longer commits the full generated FortWeb payload tree.
Before the first local run, generate the payload once with [sync-payload.sh](sync-payload.sh).
The fetch-based refresh flow still depends on the workspace [Fort-ios](../Fort-ios/README.md) checkout because Android reuses its shared manifest-validation and bridge-contract tooling.

Quick start:

```sh
./sync-payload.sh --fetch --ref 214643f4fa907061334c09c8297c4d1e59f18f45
./gradlew :app:assembleDebug
./gradlew :app:installDebug
```

If you already have a sibling FortWeb checkout, you can build from that local source instead:

```sh
./sync-payload.sh --fortweb-dir ../fortweb
```

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

If Android Studio can see the SDK but your terminal cannot find `adb`, use the repo-local preflight helper first:

```sh
./scripts/android-preflight.sh
eval "$(./scripts/android-preflight.sh --print-exports)"
./gradlew :app:connectedDebugAndroidTest
```

The helper resolves the SDK in this order: `local.properties` `sdk.dir`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`.
It prints the exact export lines for the current shell, reports `adb devices -l`, lists AVDs when no target is connected, and exits non-zero when `adb` is missing, the SDK environment is inconsistent, or no authorized emulator or device is available.

## Shared Payload Refresh

The supported shared payload source for Android is the canonical FortWeb-backed mobile payload contract.
The payload is generated locally under [app/src/main/assets/payload/](app/src/main/assets/payload/) and stays out of git.
The refresh script reads shared manifest-validation tooling and the generated Kotlin bridge contract from the workspace Fort-ios repo, but it no longer shells into the Fort-ios local payload builder.

Refresh flow:

```sh
./sync-payload.sh --fetch --ref 214643f4fa907061334c09c8297c4d1e59f18f45
```

Local workspace flow:

```sh
./sync-payload.sh --fortweb-dir ../fortweb
```

What [sync-payload.sh](sync-payload.sh) does:

1. Uses either a local FortWeb checkout or `--fetch` to obtain the FortWeb web app source
2. Generates the Android payload under [app/src/main/assets/payload/](app/src/main/assets/payload/)
3. Copies the generated Kotlin bridge contract into [app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt](app/src/main/java/org/kerifoundation/fort/bridge/BridgeContract.kt)
4. Verifies that `index.html`, `build-manifest.json`, and the generated bridge contract are present

Refresh prerequisites:

- either a sibling FortWeb checkout at `../fortweb` or `--fetch` access to the configured FortWeb git remote
- workspace Fort-ios checkout for shared tooling and generated bridge constants

The default fetch ref is pinned to FortWeb commit `214643f4fa907061334c09c8297c4d1e59f18f45` because there is not yet a published FortWeb tag for this payload contract.

If the payload has not been generated yet, the app loads a small bundled placeholder page that tells the developer to run [sync-payload.sh](sync-payload.sh). The wrapper does not download runtime code from the network.

### Current validation checkpoint

The generated-payload lane was revalidated on 2026-04-28.

- `./sync-payload.sh --fetch --ref main` generates a payload with `producer = fortweb-shared`, `payload_profile = product-shell`, and `entry_document = fortweb/app/index.html`
- `./sync-payload.sh --fetch --ref 214643f4fa907061334c09c8297c4d1e59f18f45` generates a payload with `producer = fortweb-shared`, `payload_profile = product-shell`, and `entry_document = fortweb/app/index.html`
- `./gradlew :app:testDebugUnitTest` passed after the bridge-contract refresh and placeholder fallback alignment

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
- [app/src/main/assets/bootstrap/payload-missing.html](app/src/main/assets/bootstrap/payload-missing.html): bundled placeholder shown until the payload is generated
- [app/src/main/assets/payload/](app/src/main/assets/payload/): generated local payload output used at runtime after [sync-payload.sh](sync-payload.sh) runs
- [app/src/main/res/](app/src/main/res/): launcher icon, theme, layout, and string resources
- [sync-payload.sh](sync-payload.sh): fetch or stage FortWeb and generate the Android-bundled payload locally using shared mobile tooling
- [app/build.gradle.kts](app/build.gradle.kts): app module config
- [gradle/libs.versions.toml](gradle/libs.versions.toml): dependency versions including `androidx.webkit`

## Troubleshooting

### WebView unsupported message

If the app shows the secure bridge support error, the current WebView implementation does not support the message-listener bridge required by this wrapper.
That is treated as an unsupported runtime, not as a reason to fall back to a weaker bridge.

### Payload refresh fails

If `./sync-payload.sh` fails because the sibling FortWeb checkout, the fetch remote, or the shared mobile tooling checkout is unavailable, that blocks payload generation until the input is fixed.
The app will still boot to the local placeholder page, but it will not run the real wallet payload until the sync step succeeds.

### Node version warnings during payload refresh

The refresh path runs shared Node-based manifest and payload-validation tooling from the workspace mobile repos.
If that tooling warns or fails on a local Node mismatch, treat it as a payload-generation issue, not as Android runtime behavior.

### Renderer failure message

The shell performs one bounded renderer recovery attempt.
If the renderer dies again after recovery, the app shows a native failure message instead of looping indefinitely.

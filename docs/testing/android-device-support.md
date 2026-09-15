# Android Testing Device Support

## Tier 1 — Hosted Reference (Required CI)

| Property | Value |
|---|---|
| Hardware profile | Pixel 8 |
| Android version | Android 16 |
| API level | 36 |
| System image | `system-images;android-36;google_apis;x86_64` |
| ABI | x86_64 |
| CI | GitHub-hosted Linux runner with KVM |
| Checks | Required on every PR |

The Pixel 8 profile is used because it is available in the SDK tools version installed on GitHub-hosted runners. This provides the same API 36 / Google WebView behavioral baseline that Pixel 9 would — WebView behavior is determined by the API level and system image, not the device skin.

**What Tier 1 proves:** Android 16 API-level behavior on a Google-style WebView. It does NOT prove Samsung firmware, One UI, chipset, or physical-device behavior. This is an "API 36 WebView baseline," not a Pixel 9 or Galaxy S26 hardware proof.

## Tier 2 — Physical Samsung Validation (Manual)

| Property | Value |
|---|---|
| Device | Samsung Galaxy S26 |
| Android version | Detected via `adb shell getprop ro.build.version.release` |
| One UI version | Detected via `adb shell getprop ro.build.version.oneui` |
| WebView provider | Detected via `adb shell dumpsys webviewupdate` |
| Script | `scripts/run-android-device-proof.sh` |
| Frequency | Manual, per-release, or as needed |

The Galaxy S26 ships with Android 16 and One UI 8.5. The Pixel 8 API 36 emulator provides **Android-version parity** (same API level) but not Samsung firmware or One UI parity.

**Physical Galaxy S26 execution is the only currently available direct Samsung-device evidence.**

## Tier 3 — Developer Local (Optional)

| Property | Value |
|---|---|
| Device | Pixel 9a (user's local AVD) |
| API level | 36.1 (QPR preview) |
| ABI | ARM64 |
| Status | Local only; not required CI |

## Galaxy S26 vs Emulator Parity

| Aspect | Pixel 8 Emulator (Tier 1) | Galaxy S26 Physical (Tier 2) |
|---|---|---|
| Android API level | 36 (same) | 36 (same) |
| Android version | 16 (same) | 16 (same) |
| WebView provider | Google WebView (different) | Samsung WebView (different) |
| One UI | N/A | 8.5 |
| Chipset | x86_64 emulated | Samsung Exynos/Snapdragon |
| Physical hardware | No | Yes |

**The Pixel 8 emulator and Galaxy S26 share Android-version parity (API 36) but are not hardware-equivalent.** The emulator provides a Google WebView baseline; the physical Galaxy S26 provides Samsung WebView and One UI evidence. Both are needed for a complete compatibility picture.

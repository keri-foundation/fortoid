# Synthetic Core SEDI test on Android

This developer test uses a bundled FortWeb worker in Android WebView and the
independent native KERIpy verifier. The Android device supplies the holder and
Grant; the Mac supplies synthetic authority fixtures and receives the Grant
through `adb`. This is not a live service exchange or production qualification. Use
synthetic data only. The diagnostics require an explicit test run ID and are
skipped by ordinary instrumentation runs without one.

## Inputs

- An Android emulator or an explicitly selected physical device, the Android
  SDK, a JDK, and a Python environment with the KERIpy test dependencies.
- FortWeb checkout at `a88507b38b6cf15a938b80ce4833f93642b9c7aa`, with the
  committed Core fixture and native-verifier scripts unchanged.
- Native KERIpy source at `84301a9ff4bbb644ce134f9649ad56b49aa130f2`. The
  host test checks the two reference files used by the verifier.
- The candidate FortWeb ZIP with SHA-256
  `275e48af129a8329cd8870fb799981f14466f88758ad02ba1d7a479cd1d4f1e5`, and
  manifest SHA-256
  `665722ddca6a8a367086e439b64f4c15f888df7e36287954f19948a3ba7e6644`.
- A device clock within one second of the host. The test refuses a larger
  difference instead of altering signed messages or relaxing KRAM freshness.

## Build and run on an emulator

From this test branch, verify the ZIP checksum and lock, then use the canonical
importer. The `-r` installs update the emulator apps without clearing data.
Choose a new results directory for each run.

```sh
shasum -a 256 "$FORTWEB_RUNTIME_ZIP"
cat config/fortweb-runtime.json
./sync-payload.sh --package "$FORTWEB_RUNTIME_ZIP"
node tools/validate-staged-payload.mjs
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
node tools/verify-packaged-runtime.mjs --apk app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_EMULATOR" install -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_EMULATOR" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$KERIPY_PYTHON" tools/sedi-core-android-test.py \
  --adb "$(command -v adb)" --device "$ANDROID_EMULATOR" \
  --keripy "$KERIPY_SOURCE" --fortweb "$FORTWEB_SOURCE" \
  --output "$NEW_RESULTS_DIRECTORY" \
  --manifest-sha256 665722ddca6a8a367086e439b64f4c15f888df7e36287954f19948a3ba7e6644 \
  --fortweb-commit a88507b38b6cf15a938b80ce4833f93642b9c7aa
```

The test checks the installed manifest and all 160 files, creates fresh
synthetic holder state, preloads the native verifier, and transfers the signed
Grant. It compares the device and host CESR hashes. The verifier accepts the
fresh Grant under the reference KRAM configuration and checks wrong binding,
missing authority, missing proof and stale replay. It then rechecks the
original accepted exchange after a worker restart. A successful command exits
zero and writes a report and verifier logs; a partial report is not a pass.

Invalid preflight inputs are checked against the exported holder KEL, registry
view, and hashes of the test vault's relevant signed-state stores and pending
markers. The recovered
Grant bytes are test-owned. The separate single-credential lifecycle diagnostic
can exercise process-restart and offline recovery; that result is not Core
process-restart or offline acceptance. Its write phase saves a synthetic
checkpoint in the test app's private files; the read phase requires that same
checkpoint and a new process. A missing checkpoint fails without creating a
new synthetic credential.

If clocks differ, correct the emulator's system clock using its normal time
settings and restore any temporary setting afterward. Never change the signed
timestamp or verifier freshness settings. Preserve failed outputs and signed
state; do not clear a pending marker. Raw outputs contain synthetic evidence
and local metadata and should be reviewed before sharing.

Earlier device testing used FortWeb commit
`374583defa75a6e2e0eb933e5a3cbdef192f79e4` and the original qualified runtime.
The updated pin above has not yet been rerun on a physical device.

The runtime v2, fetched-WebAssembly, signing-root confidentiality, and pending
operation recovery boundaries remain open independently of this test.

## Physical-device preparation

Physical-device testing is opt-in and uses the separate debug application ID
`org.kerifoundation.fortandroid.seditest` and test ID
`org.kerifoundation.fortandroid.seditest.test`. The standard app and its data
must be left intact. Before installing, select the intended device by its exact
ADB serial and check every device user, including retained packages, for both
test IDs. Stop if the device is unauthorized or an existing package cannot be
identified as the isolated test installation.

After importing the candidate runtime as above, build both APKs:

```sh
./gradlew -PsediPhysicalTest=true :app:assembleDebug :app:assembleDebugAndroidTest
```

Inspect the APK manifests and signatures: the app must be debuggable, have no
shared user ID, and use the test application ID; the instrumentation APK must
use the test ID, target that application ID, and have the same signing
certificate. Verify the packaged runtime with the command above.

For an initial installation, install the app and then the instrumentation APK
using `adb -s "$ANDROID_SERIAL" install` and their respective paths above.
Do not replace an existing wallet app, uninstall anything, or clear app data. If
installation fails, preserve the error and investigate without bypassing the
device's verification. Check that the phone's clock agrees with the host before
running the host command above with `--device "$ANDROID_SERIAL"` and the
additional `--physical-device` flag. The test checks the selected serial,
isolated instrumentation target, app debuggability, and clock before running.
Keep the device's network settings unchanged; an offline test requires separate
authorization. A successful physical run must be recorded separately from the
emulator result, and the limitations described above still apply.

### Core recovery after application restart

Use the same command with both `--physical-device` and `--app-restart` to run
the write, confirmed process-stop and read phases without reinstalling the app.
The physical mode checks the exact isolated test package before stopping it.
The runner creates a fresh synthetic vault and result directory on each run.
Record the Android source revision with `git rev-parse HEAD` and hash both APKs
and the runtime ZIP before testing. If the isolated test app is already
installed, update its instrumentation package only after checking its package
ID, target and signing certificate; do not replace the app or any other package.

With the verified test app and matching instrumentation already installed:

```sh
shasum -a 256 "$FORTWEB_RUNTIME_ZIP" app/build/outputs/apk/debug/app-debug.apk \
  app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
git rev-parse HEAD
"$KERIPY_PYTHON" tools/sedi-core-android-test.py \
  --physical-device --app-restart --adb "$(command -v adb)" --device "$ANDROID_SERIAL" \
  --keripy "$KERIPY_SOURCE" --fortweb "$FORTWEB_SOURCE" --output "$NEW_RESULTS_DIRECTORY" \
  --manifest-sha256 665722ddca6a8a367086e439b64f4c15f888df7e36287954f19948a3ba7e6644 \
  --fortweb-commit a88507b38b6cf15a938b80ce4833f93642b9c7aa
```

The write phase validates the fresh Grant with native KERIpy and closes the
vault before saving a test-owned checkpoint containing public identifiers and
digests. The read phase requires that checkpoint and a different process, opens
the same vault, and reads the existing Core credential, Grant metadata,
presentation binding and targeted signed-state stores. It compares nested Grant
substreams with the original independently accepted Grant, rejects missing
credentials and mismatched bindings, and checks pending markers. The existing
native verifier then rechecks the accepted historical exchange without treating
it as a fresh KRAM request.

The binding comparison reads the existing test record directly: the normal
`registries.present` operation may create a missing binding and therefore is
not suitable as a recovery assertion. Presentation TEL event bytes are checked
against the original Grant result as well as the stored registry hashes.

This proves only the recorded synthetic state and targeted store comparisons.
The verifier retains its own accepted exchange; the test does not establish a
complete application-owned IPEX outbox or independent recovery of every
authority registry. A missing or duplicate checkpoint, incomplete report,
failed instrumentation, or failed native recheck is a failure. Preserve the
synthetic app state and result directory; do not clear state or retry writes in
the same vault. Offline cold-launch recovery is separate and remains untested
unless explicitly authorized and performed.

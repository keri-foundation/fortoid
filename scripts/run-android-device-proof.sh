#!/usr/bin/env bash
# Manual connected-device proof runner for physical Galaxy S26.
# Usage: bash scripts/run-android-device-proof.sh [--serial <id>]

set -euo pipefail

SERIAL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial) SERIAL="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 2 ;;
  esac
done

ADB="adb"
if [[ -n "$SERIAL" ]]; then
  ADB="adb -s $SERIAL"
fi

echo "=== Device Identity ==="
MODEL=$($ADB shell getprop ro.product.model)
DEVICE=$($ADB shell getprop ro.product.device)
MANUF=$($ADB shell getprop ro.product.manufacturer)
RELEASE=$($ADB shell getprop ro.build.version.release)
SDK=$($ADB shell getprop ro.build.version.sdk)
FINGERPRINT=$($ADB shell getprop ro.build.fingerprint)
ONEUI=$($ADB shell getprop ro.build.version.oneui 2>/dev/null || echo "not detected")

echo "Manufacturer: $MANUF"
echo "Model:        $MODEL"
echo "Device:       $DEVICE"
echo "Android:      $RELEASE (SDK $SDK)"
echo "One UI:       $ONEUI"
echo "Fingerprint:  $FINGERPRINT"

echo ""
echo "=== WebView ==="
$ADB shell dumpsys webviewupdate 2>/dev/null | grep -E 'Current|version|package' || echo "WebView info N/A"
$ADB shell pm list packages | grep -i webview || echo "No webview packages"

echo ""
echo "=== Device Classification ==="
if echo "$MODEL" | grep -qi "S26"; then
  echo "Device IS a Galaxy S26 variant"
else
  echo "Device is NOT detected as Galaxy S26 (model: $MODEL)"
  echo "Manual override required if this is incorrect."
fi

echo ""
echo "=== Worker Proof ==="
echo "Run: ./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=org.kerifoundation.fortandroid.WorkerRuntimeProofTest"

echo ""
echo "=== Persistence Proof ==="
KEY="probe-$(date +%s)-$RANDOM"
VALUE="val-$(uuidgen 2>/dev/null || echo "val-$RANDOM")"
echo "Generated key: $KEY"
echo "Generated value: $VALUE"

echo ""
echo "--- Phase A: Write ---"
$ADB shell am instrument -w -r \
  -e persistenceKey "$KEY" \
  -e persistenceValue "$VALUE" \
  -e class org.kerifoundation.fortandroid.PersistenceWriteTest \
  org.kerifoundation.fortandroid.test/androidx.test.runner.AndroidJUnitRunner

echo ""
echo "--- Force-stop ---"
$ADB shell am force-stop org.kerifoundation.fortandroid
sleep 2
echo "Process stopped"

echo ""
echo "--- Phase B: Read ---"
$ADB shell am instrument -w -r \
  -e persistenceKey "$KEY" \
  -e persistenceValue "$VALUE" \
  -e class org.kerifoundation.fortandroid.PersistenceReadTest \
  org.kerifoundation.fortandroid.test/androidx.test.runner.AndroidJUnitRunner

echo ""
echo "=== Complete ==="
echo "Review output above for OK/FAIL results."

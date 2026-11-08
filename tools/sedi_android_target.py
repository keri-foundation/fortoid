"""Select and verify the isolated target for synthetic Android tests."""

import subprocess

EMULATOR_PACKAGE = "org.kerifoundation.fortandroid"
PHYSICAL_PACKAGE = "org.kerifoundation.fortandroid.seditest"


def select_package(serial, physical):
    if not serial or physical == serial.startswith("emulator-"):
        raise ValueError("physical devices require --physical-device; emulator runs must omit it")
    return PHYSICAL_PACKAGE if physical else EMULATOR_PACKAGE


def verify_physical_target(adb, serial):
    def text(*command):
        return subprocess.run(adb + list(command), capture_output=True, text=True,
                              check=True, timeout=15).stdout.strip()

    if text("get-state") != "device" or text("get-serialno") != serial:
        raise RuntimeError("the physical device is unauthorized or its serial does not match")
    if text("shell", "getprop", "ro.kernel.qemu") not in ("", "0"):
        raise RuntimeError("physical mode cannot target an emulator")
    installed = subprocess.run(adb + ["shell", "pm", "path", PHYSICAL_PACKAGE],
                               capture_output=True, text=True, timeout=15)
    if installed.returncode or not installed.stdout.strip().startswith("package:"):
        raise RuntimeError("the isolated development app is not installed")
    instrumentation = text("shell", "pm", "list", "instrumentation")
    expected = (f"instrumentation:{PHYSICAL_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner "
                f"(target={PHYSICAL_PACKAGE})")
    if expected not in instrumentation.splitlines():
        raise RuntimeError("isolated instrumentation package or target is missing")
    text("shell", "run-as", PHYSICAL_PACKAGE, "id")


def verify_stopped(adb, package):
    if package != PHYSICAL_PACKAGE:
        raise ValueError("only the isolated development app may be stopped")
    result = subprocess.run(adb + ["shell", "pidof", package], capture_output=True, text=True, timeout=15)
    if result.returncode != 1 or result.stdout.strip() or result.stderr.strip():
        raise RuntimeError("could not confirm the isolated application process stopped")

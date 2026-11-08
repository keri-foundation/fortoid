import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sedi_android_target import EMULATOR_PACKAGE, PHYSICAL_PACKAGE, select_package, verify_physical_target, verify_stopped


def response(stdout="", returncode=0, stderr=""):
    return SimpleNamespace(stdout=stdout, returncode=returncode, stderr=stderr)


class AndroidTargetTest(unittest.TestCase):
    def test_stop_requires_unambiguous_pidof_result_and_isolated_package(self):
        adb = ["adb", "-s", "SERIAL"]
        with patch("sedi_android_target.subprocess.run", return_value=response(returncode=1)) as run:
            verify_stopped(adb, PHYSICAL_PACKAGE)
            run.assert_called_once_with(adb + ["shell", "pidof", PHYSICAL_PACKAGE],
                                        capture_output=True, text=True, timeout=15)
        for result in (response("1234"), response(returncode=255), response(returncode=1, stderr="device offline")):
            with self.subTest(result=result), patch("sedi_android_target.subprocess.run", return_value=result):
                with self.assertRaisesRegex(RuntimeError, "could not confirm"):
                    verify_stopped(adb, PHYSICAL_PACKAGE)
        with self.assertRaises(ValueError):
            verify_stopped(adb, EMULATOR_PACKAGE)

    def test_modes_require_explicit_physical_opt_in(self):
        self.assertEqual(select_package("emulator-5554", False), EMULATOR_PACKAGE)
        self.assertEqual(select_package("SERIAL", True), PHYSICAL_PACKAGE)
        for serial, physical in (("SERIAL", False), ("emulator-5554", True), ("", True)):
            with self.subTest(serial=serial, physical=physical), self.assertRaises(ValueError):
                select_package(serial, physical)

    def test_physical_checks_only_the_isolated_package(self):
        runner = f"instrumentation:{PHYSICAL_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner (target={PHYSICAL_PACKAGE})"
        results = [response("device"), response("SERIAL"), response("0"),
                   response("package:/data/app/test.apk"), response(runner), response("uid=10001")]
        with patch("sedi_android_target.subprocess.run", side_effect=results) as run:
            verify_physical_target(["adb", "-s", "SERIAL"], "SERIAL")
        calls = [call.args[0] for call in run.call_args_list]
        self.assertIn(["adb", "-s", "SERIAL", "shell", "run-as", PHYSICAL_PACKAGE, "id"], calls)
        self.assertNotIn(["adb", "-s", "SERIAL", "shell", "run-as", EMULATOR_PACKAGE, "id"], calls)

    def test_rejects_wrong_serial_emulator_or_missing_isolation(self):
        runner = f"instrumentation:{PHYSICAL_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner (target={PHYSICAL_PACKAGE})"
        cases = [
            ([response("device"), response("OTHER")], "serial"),
            ([response("device"), response("SERIAL"), response("1")], "emulator"),
            ([response("device"), response("SERIAL"), response("0"), response(returncode=1)], "not installed"),
            ([response("device"), response("SERIAL"), response("0"), response("package:/test.apk"),
              response(runner.replace(f"target={PHYSICAL_PACKAGE}", f"target={EMULATOR_PACKAGE}"))], "instrumentation"),
        ]
        for results, message in cases:
            with self.subTest(message=message), patch("sedi_android_target.subprocess.run", side_effect=results):
                with self.assertRaisesRegex(RuntimeError, message):
                    verify_physical_target(["adb", "-s", "SERIAL"], "SERIAL")

    def test_rejects_non_debuggable_target(self):
        runner = f"instrumentation:{PHYSICAL_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner (target={PHYSICAL_PACKAGE})"
        results = [response("device"), response("SERIAL"), response("0"), response("package:/test.apk"),
                   response(runner), subprocess.CalledProcessError(1, "run-as")]
        with patch("sedi_android_target.subprocess.run", side_effect=results), self.assertRaises(subprocess.CalledProcessError):
            verify_physical_target(["adb", "-s", "SERIAL"], "SERIAL")


if __name__ == "__main__":
    unittest.main()

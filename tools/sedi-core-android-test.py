"""Run the synthetic Core SEDI instrumentation with the FortWeb native verifier."""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sedi_android_target import select_package, verify_physical_target, verify_stopped

parser = argparse.ArgumentParser()
for option in ("adb", "device", "keripy", "fortweb", "output", "manifest-sha256", "fortweb-commit"):
    parser.add_argument(f"--{option}", required=True)
parser.add_argument("--physical-device", action="store_true")
parser.add_argument("--app-restart", action="store_true")
args = parser.parse_args()
if args.app_restart and not args.physical_device:
    parser.error("app restart requires the isolated physical-device package")
try:
    package = select_package(args.device, args.physical_device)
except ValueError as error:
    parser.error(str(error))
keripy = Path(args.keripy).resolve(strict=True)
fortweb = Path(args.fortweb).resolve(strict=True)
root = Path(args.output).resolve()
root.mkdir(exist_ok=False)
head = subprocess.run(["git", "-C", str(fortweb), "rev-parse", "HEAD"], capture_output=True,
                      text=True, check=True).stdout.strip()
if head != args.fortweb_commit:
    raise ValueError("FortWeb checkout differs from the requested commit")
for name in ("playwright/fixtures/sedi-core-reference.py", "playwright/fixtures/sedi-core-verifier.py"):
    committed = subprocess.run(["git", "-C", str(fortweb), "show", f"{head}:{name}"],
                               capture_output=True, check=True).stdout
    if (fortweb / name).read_bytes() != committed:
        raise ValueError(f"FortWeb fixture differs from its committed version: {name}")
for name, expected in {
    "src/keri/acdc/ipexing.py": "fadc924b0e48b3e3f8f82d0730f5f2e3b6938149a38915c9b43fee715e3a5806",
    "tests/sedi/test_ipex_sedi.py": "0309bcc6c11a5da1754ad05939ce565c8fb6094e9f7db02e4310639963e7c9a2",
}.items():
    if hashlib.sha256((keripy / name).read_bytes()).hexdigest() != expected:
        raise ValueError(f"native KERIpy reference differs: {name}")
sys.path[:0] = [str(keripy / "src"), str(keripy)]
os.environ["PYTHONPATH"] = os.pathsep.join((str(keripy / "src"), str(keripy)))
from keri.core import SerderKERI
from tests.sedi.test_ipex_sedi import _KRAM_CONFIG

run_id = uuid.uuid4().hex
remote = f"files/sedi-core-{run_id}"
test_package = f"{package}.test"
adb = [args.adb, "-s", args.device]
if args.physical_device:
    verify_physical_target(adb, args.device)
clock_start = time.time()
device_clock = subprocess.run(adb + ["shell", "date", "+%s.%3N"], capture_output=True,
                              text=True, check=True, timeout=15)
clock_end = time.time()
clock_offset = float(device_clock.stdout.strip()) - (clock_start + clock_end) / 2
if abs(clock_offset) > 1:
    raise RuntimeError("device clock differs from host by more than one second")
children = {}
logs = {}
test = None


def receive(name, timeout=240):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        path = f"{remote}/{name}"
        command = f"run-as {package} sh -c 'if [ -f {path} ]; then cat {path}; else exit 42; fi'"
        result = subprocess.run(adb + ["shell", "-T", command], capture_output=True, timeout=15)
        if result.returncode == 0 and result.stdout:
            (root / name).write_bytes(result.stdout)
            return result.stdout
        if test is not None and test.poll() is not None:
            raise RuntimeError(f"instrumentation ended before {name}")
        time.sleep(0.1)
    raise TimeoutError(f"device did not provide {name}")


def send(name, data):
    path = f"{remote}/{name}"
    command = f"run-as {package} sh -c 'cat > {path}.tmp && mv {path}.tmp {path}'"
    subprocess.run(adb + ["shell", command], input=data, capture_output=True, check=True, timeout=20)


def wait_log(mode, marker, timeout=120):
    end = time.monotonic() + timeout
    path = root / f"verifier-{mode}.log"
    while time.monotonic() < end:
        text = path.read_text()
        if marker in text:
            return text
        if children[mode].poll() is not None:
            raise RuntimeError(f"{mode} verifier exited before {marker}")
        time.sleep(0.1)
    raise TimeoutError(f"{mode} verifier did not reach {marker}")


try:
    instrumentation_log = (root / "instrumentation.log").open("w")
    test = subprocess.Popen(adb + ["shell", "am", "instrument", "-w", "-r", "-e", "class",
        "org.kerifoundation.fortandroid.RuntimeLifecycleDiagnosticTest#syntheticCoreSediPresentation",
        "-e", "runId", run_id, "-e", "manifestSha256", args.manifest_sha256,
        "-e", "fortwebCommit", args.fortweb_commit, "-e", "expectedPackage", package,
        f"{test_package}/androidx.test.runner.AndroidJUnitRunner"],
        stdout=instrumentation_log, stderr=subprocess.STDOUT)
    holder = json.loads(receive("holder.json"))
    fixture = subprocess.run([sys.executable, fortweb / "playwright/fixtures/sedi-core-reference.py",
        holder["holderAid"], holder["registryId"]], capture_output=True, check=True).stdout
    json.loads(fixture)
    (root / "core-public-fixture.json").write_bytes(fixture)
    send("fixture.json", fixture)
    modes = ("valid", "wrong", "missing", "missing-agent", "missing-proof")
    for mode in modes:
        env = dict(os.environ, PYTHONUNBUFFERED="1", FORTWEB_NATIVE_WAIT="1",
                   FORTWEB_NATIVE_RECHECK="1" if mode == "valid" else "0",
                   PYTHONPATH=os.pathsep.join((str(keripy / "src"), str(keripy))))
        logs[mode] = (root / f"verifier-{mode}.log").open("w")
        children[mode] = subprocess.Popen([sys.executable, fortweb / "playwright/fixtures/sedi-core-verifier.py",
            str(root), mode], env=env, stdin=subprocess.PIPE, stdout=logs[mode],
            stderr=subprocess.STDOUT, text=True)
    for mode in modes:
        wait_log(mode, "READY")
    ready = json.loads(receive("ready.json"))
    if any(ready.get(key) is not True for key in ("invalidRejected", "holderKelUnchanged", "registryViewUnchanged")):
        raise AssertionError("preflight did not preserve holder KEL or registry view")
    send("go.json", b"{}")
    received = receive("fortweb-presentation.json")
    received_wall = datetime.now(timezone.utc)
    for child in children.values():
        child.stdin.write("go\n")
        child.stdin.flush()
    presentation = json.loads(received)
    cesr = base64.b64decode(presentation["exchange"]["cesr"], validate=True)
    digest = hashlib.sha256(cesr).hexdigest()
    if digest != receive("grant-cesr.sha256").decode().strip():
        raise AssertionError("Grant bytes differ across device transfer")
    timing = json.loads(receive("grant-timing.json"))
    expected = {"wrong": "rejected wrong evidence", "missing": "rejected missing evidence",
                "missing-agent": "rejected missing-agent evidence", "missing-proof": "rejected missing-proof evidence"}
    outcomes = {}
    for mode, marker in expected.items():
        code = children[mode].wait(timeout=120)
        text = (root / f"verifier-{mode}.log").read_text()
        outcomes[mode] = code == 0 and marker in text and "kram intake accepted= True" in text
    valid_log = wait_log("valid", "ACCEPTED")
    outcomes["valid"] = ("accepted Core Grant and all three authority nodes" in valid_log and
                         "kram intake accepted= True" in valid_log)
    recovery = json.loads(receive("recovered.json"))
    if any(recovery.get(key) is not True for key in ("credentialRecovered", "bindingRecovered", "grantMetadataRecovered")):
        raise AssertionError("Core recovery was incomplete")
    native = {"valid": outcomes["valid"], "wrong": outcomes["wrong"], "missing": outcomes["missing"],
              "missingAgent": outcomes["missing-agent"], "missingProof": outcomes["missing-proof"]}
    if not all(native.values()):
        raise AssertionError("native acceptance or negative checks failed")
    send("native-result.json", json.dumps(native).encode())
    checkpoint = json.loads(receive("core-checkpoint.json"))
    test_code = test.wait(timeout=120)
    instrumentation_log.flush()
    instrumentation = (root / "instrumentation.log").read_text()
    if (test_code != 0 or "OK (1 test)" not in instrumentation or "INSTRUMENTATION_CODE: -1" not in instrumentation
            or "INSTRUMENTATION_STATUS_CODE: -3" in instrumentation):
        raise AssertionError("Android instrumentation did not pass exactly one test")
    from keri import Vrsn_2_0
    from keri.core import Parser
    from keri.peer.exchanging import serializeParsedSubstream
    parsed, = Parser(version=Vrsn_2_0).parse(ims=bytearray(cesr), framed=False, processive=False)
    nested_hashes = [hashlib.sha256(bytes(serializeParsedSubstream(node))).hexdigest() for node in parsed.nests]
    if nested_hashes != checkpoint["data"]["snapshot"]["nestedSha256"]:
        raise AssertionError("persisted Core substreams differ from the accepted Grant")
    process_recovery = None
    if args.app_restart:
        started = time.monotonic()
        subprocess.run(adb + ["shell", "am", "force-stop", package], check=True, timeout=15)
        verify_stopped(adb, package)
        with (root / "instrumentation-read.log").open("w") as read_log:
            test = subprocess.Popen(adb + ["shell", "am", "instrument", "-w", "-r", "-e", "class",
                "org.kerifoundation.fortandroid.RuntimeLifecycleDiagnosticTest#syntheticCoreSediPresentation",
                "-e", "runId", run_id, "-e", "phase", "read", "-e", "manifestSha256", args.manifest_sha256,
                "-e", "fortwebCommit", args.fortweb_commit, "-e", "expectedPackage", package,
                f"{test_package}/androidx.test.runner.AndroidJUnitRunner"], stdout=read_log, stderr=subprocess.STDOUT)
            process_recovery = json.loads(receive("process-recovered.json"))
            read_code = test.wait(timeout=120)
        read_output = (root / "instrumentation-read.log").read_text()
        if (read_code != 0 or "OK (1 test)" not in read_output or "INSTRUMENTATION_CODE: -1" not in read_output
                or "INSTRUMENTATION_STATUS_CODE: -3" in read_output):
            raise AssertionError("Core process-recovery instrumentation did not pass")
        if process_recovery["processId"] == checkpoint["processId"]:
            raise AssertionError("Core recovery did not use a new app process")
        process_recovery["writeProcessId"] = checkpoint["processId"]
        process_recovery["seconds"] = time.monotonic() - started
    children["valid"].stdin.write("recheck\n")
    children["valid"].stdin.flush()
    code = children["valid"].wait(timeout=120)
    native["rechecked"] = code == 0 and "rechecked the original accepted Core Grant" in (root / "verifier-valid.log").read_text()
    timestamp = datetime.fromisoformat(SerderKERI(raw=cesr).ked["dt"])
    drift, short_lag, *_ = _KRAM_CONFIG["kram"]["caches"]["~"]
    while (datetime.now(timezone.utc) - timestamp).total_seconds() <= (drift + short_lag) / 1000 + 1:
        time.sleep(0.1)
    env = dict(os.environ, FORTWEB_NATIVE_WAIT="0", FORTWEB_NATIVE_RECHECK="0",
               PYTHONPATH=os.pathsep.join((str(keripy / "src"), str(keripy))))
    stale = subprocess.run([sys.executable, fortweb / "playwright/fixtures/sedi-core-verifier.py",
                            str(root), "valid"], capture_output=True, text=True, timeout=120, env=env)
    (root / "verifier-stale.log").write_text(stale.stdout + stale.stderr)
    stale_rejected = stale.returncode != 0 and "kram intake accepted= False" in stale.stdout
    report = {"native": native, "recovery": recovery, "cesr_sha256": digest,
              "manifest_sha256": args.manifest_sha256, "fortweb_commit": args.fortweb_commit,
              "kram_config": _KRAM_CONFIG["kram"]["caches"]["~"],
              "device_clock_offset_seconds": clock_offset, "device_clock_roundtrip_seconds": clock_end - clock_start,
              "grant_timestamp": timestamp.isoformat(), "device_export_unix": timing["wallSeconds"],
              "host_received": received_wall.isoformat(),
              "grant_age_at_host_seconds": (received_wall - timestamp).total_seconds(),
              "instrumentation_passed": True, "stale_rejected_by_kram": stale_rejected,
              "invalid_preflight_rejected_without_kel_change": True, "registry_view_unchanged": True,
              "preflight_signed_state_unchanged": True, "accepted_nested_streams_match": True,
              "process_recovery": process_recovery}
    (root / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    if not all(native.values()) or not stale_rejected:
        sys.exit(1)
finally:
    for child in children.values():
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
    for log in logs.values():
        log.close()
    if test is not None and test.poll() is None:
        test.terminate()
        test.wait(timeout=30)
    if test is not None:
        instrumentation_log.close()

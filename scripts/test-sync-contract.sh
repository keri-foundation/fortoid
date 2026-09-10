#!/usr/bin/env bash
# ── test-sync-contract.sh ─────────────────────────────────────────────────────
# Contract tests for sync-payload.sh behaviour.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/../sync-payload.sh"
PASS=0
FAIL=0

assert_fails() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL: ${desc} (expected failure, got success)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  fi
}

assert_fails_with_msg() {
  local desc="$1"
  local expected_msg="$2"
  shift 2
  local output
  output="$("$@" 2>&1)" || true
  if echo "${output}" | grep -q "${expected_msg}"; then
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${desc} (expected '${expected_msg}' in output, got: ${output})"
    FAIL=$((FAIL + 1))
  fi
}

assert_passes() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${desc} (expected success)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== sync-payload.sh contract tests ==="
echo ""

# ── Argument validation ───────────────────────────────────────────────────────

assert_fails_with_msg \
  "no arguments prints usage" \
  "Usage" \
  "${SYNC_SCRIPT}"

assert_fails_with_msg \
  "local mode requires --fortweb-dir" \
  "error: --fortweb-dir is required" \
  "${SYNC_SCRIPT}"

assert_fails_with_msg \
  "fetch mode without --ref fails" \
  "error: --fetch requires --ref" \
  "${SYNC_SCRIPT}" --fetch

# ── Invalid directory ─────────────────────────────────────────────────────────

assert_fails_with_msg \
  "nonexistent FortWeb dir fails" \
  "error: FortWeb directory not found" \
  "${SYNC_SCRIPT}" --fortweb-dir /tmp/nonexistent-fortweb-12345

# ── Non-git directory ─────────────────────────────────────────────────────────

TMP_NON_GIT="$(mktemp -d)"
assert_fails_with_msg \
  "non-git directory fails" \
  "is not a Git repository" \
  "${SYNC_SCRIPT}" --fortweb-dir "${TMP_NON_GIT}"
rm -rf "${TMP_NON_GIT}"

# ── Valid sync against real FortWeb ───────────────────────────────────────────

FORTWEB_DIR="${SCRIPT_DIR}/../../fortweb"
if [[ -d "${FORTWEB_DIR}/.git" ]]; then
  assert_passes \
    "sync against real FortWeb succeeds" \
    "${SYNC_SCRIPT}" --fortweb-dir "${FORTWEB_DIR}"

  # Verify output exists
  PAYLOAD_DIR="${SCRIPT_DIR}/../app/src/main/assets/payload"
  if [[ -f "${PAYLOAD_DIR}/index.html" ]] && \
     [[ -f "${PAYLOAD_DIR}/fortweb/app/index.html" ]] && \
     [[ -f "${PAYLOAD_DIR}/fortweb/app/app/main.js" ]] && \
     [[ -f "${PAYLOAD_DIR}/android-payload-manifest.json" ]]; then
    echo "PASS: staged payload files present"
    PASS=$((PASS + 1))
  else
    echo "FAIL: staged payload files missing"
    FAIL=$((FAIL + 1))
  fi

  # Verify no raw TypeScript source (.d.ts declaration files are fine)
  if find "${PAYLOAD_DIR}/fortweb" -name '*.ts' ! -name '*.d.ts' 2>/dev/null | grep -q .; then
    echo "FAIL: raw TypeScript source found in staged payload"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: no raw TypeScript source in staged payload"
    PASS=$((PASS + 1))
  fi
else
  echo "SKIP: FortWeb not found at ${FORTWEB_DIR} (integration test skipped)"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi

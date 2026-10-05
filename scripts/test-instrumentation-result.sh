#!/usr/bin/env bash
# Hermetic regression tests for AndroidJUnitRunner result acceptance.
#
# Requires no Android device, emulator, Android SDK, or network: the predicate
# is exercised directly against captured runner output. This is the acceptance
# logic that decides whether a manual physical-device proof may proceed.
#
# Usage: bash scripts/test-instrumentation-result.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/instrumentation-result.sh
source "${SCRIPT_DIR}/instrumentation-result.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fortoid-instrumentation-test.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

PASSED=0
FAILED=0

# expect_result <description> <expected-count> <adb-status> <output> <want>
#   want: 0 means the run must be accepted, 1 means it must be rejected
expect_result() {
  local desc="$1" expected="$2" status="$3" output="$4" want="$5"
  local slug
  slug="$(printf '%s' "$desc" | tr -c 'A-Za-z0-9' '_')"
  local file
  file="${TMP}/${PASSED}_${FAILED}_${slug}.txt"
  printf '%s' "$output" > "$file"

  local got=0
  verify_instrumentation_result "$expected" "$status" "$file" >/dev/null 2>&1 || got=1

  if [[ "$got" -eq "$want" ]]; then
    echo "PASS: ${desc}"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: ${desc} (wanted rejection=${want}, got rejection=${got})"
    FAILED=$((FAILED + 1))
  fi
}

# ── Fixtures: real AndroidJUnitRunner shapes ────────────────────────────────

RUNNER_PREFIX='INSTRUMENTATION_STATUS: class=org.kerifoundation.fortandroid.WorkerRuntimeProofTest
INSTRUMENTATION_STATUS: current=1
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: worker never reached ready
INSTRUMENTATION_STATUS_CODE: -2
'

RUNNER_TAIL='INSTRUMENTATION_CODE: -1
'

FAILED_RUN="${RUNNER_PREFIX}
FAILURES!!!
Tests run: 2,  Failures: 1

${RUNNER_TAIL}"

OK_TWO="Time: 1.234

OK (2 tests)

${RUNNER_TAIL}"

OK_ONE="Time: 0.412

OK (1 test)

${RUNNER_TAIL}"

OK_ZERO="Time: 0.001

OK (0 tests)

${RUNNER_TAIL}"

# Status chatter with no terminal runner summary at all.
STATUS_ONLY="${RUNNER_PREFIX}
${RUNNER_TAIL}"

# "OK" present but not as the terminal result line.
OK_NOT_TERMINAL="OK (2 tests)

Tests run: 2,  Failures: 1
${RUNNER_TAIL}"

# ── Cases ───────────────────────────────────────────────────────────────────

# A/G — the reviewer scenario: adb exits 0 while the runner reports failures.
expect_result "A reviewer false-green: adb exit 0 with FAILURES is rejected" \
  2 0 "$FAILED_RUN" 1

# B — the Worker suite's real success shape.
expect_result "B worker OK (2 tests) for expected 2 is accepted" \
  2 0 "$OK_TWO" 0

# C — wrong count must not be accepted.
expect_result "C OK (1 test) for expected 2 is rejected" \
  2 0 "$OK_ONE" 1

# D — the persistence suites' real success shape.
expect_result "D persistence OK (1 test) for expected 1 is accepted" \
  1 0 "$OK_ONE" 0

# E — truncated/ordinary status output with no terminal summary.
expect_result "E missing terminal summary is rejected" \
  2 0 "$STATUS_ONLY" 1

# F — process failure fails closed regardless of output.
expect_result "F nonzero adb status with OK output is rejected" \
  2 1 "$OK_TWO" 1

# G — explicit failure summary with a clean adb status.
expect_result "G explicit FAILURES summary with adb exit 0 is rejected" \
  2 0 "$FAILED_RUN" 1

# H — "OK" somewhere is not proof of success.
expect_result "H OK not in terminal position is rejected" \
  2 0 "$OK_NOT_TERMINAL" 1

# I — zero tests is not a passing proof.
expect_result "I OK (0 tests) is rejected" \
  2 0 "$OK_ZERO" 1

# J — a wrong expected count on the persistence suite is rejected too.
expect_result "J OK (2 tests) for expected 1 is rejected" \
  1 0 "$OK_TWO" 1

echo ""
echo "── Results: ${PASSED} passed, ${FAILED} failed ──"

[[ "$FAILED" -eq 0 ]] || exit 1
exit 0

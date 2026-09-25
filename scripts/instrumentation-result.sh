#!/usr/bin/env bash
# ── instrumentation-result.sh ────────────────────────────────────────────────
#
# Sourceable acceptance predicate for AndroidJUnitRunner output.
#
# `adb shell am instrument` reports the adb process status, which is 0 even when
# AndroidJUnitRunner reports failing tests. The only trustworthy success signal
# is the runner's own terminal summary, so success is established positively
# from captured output instead of from the process exit status.
#
# Sourced by scripts/run-android-device-proof.sh and exercised directly by
# scripts/test-instrumentation-result.sh.

# Verify one captured instrumentation run.
#
# Arguments:
#   $1 expected  exact number of passing tests the suite must report
#   $2 status    exit status of the adb instrumentation process
#   $3 file      file holding the captured combined output
#
# Returns 0 only when the process exited cleanly AND its final non-blank result
# line is an AndroidJUnitRunner success summary for exactly `expected` tests.
# Otherwise returns 1 and prints a specific reason, so the cause stays
# attributable in terminal and CI logs.
verify_instrumentation_result() {
  local expected="$1"
  local status="$2"
  local file="$3"

  if [[ ! "$expected" =~ ^[0-9]+$ ]]; then
    echo "FAIL: expected test count must be numeric, got '${expected}'" >&2
    return 1
  fi
  if [[ ! "$file" =~ ^/ ]]; then
    echo "FAIL: instrumentation output path must be absolute, got '${file}'" >&2
    return 1
  fi
  if [[ ! -f "$file" ]]; then
    echo "FAIL: instrumentation output file not found: ${file}" >&2
    return 1
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "FAIL: instrumentation command exited ${status}" >&2
    return 1
  fi

  # adb shell emits CRLF; normalize before matching line shapes.
  local normalized
  normalized="$(tr -d '\r' < "$file")"

  # Explicit runner failures, reported specifically so the failure mode is
  # attributable rather than surfacing only as a missing success summary.
  if grep -qE 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED|Process crashed' <<<"$normalized"; then
    echo "FAIL: AndroidJUnitRunner reported a failure result" >&2
    return 1
  fi

  # The terminal result line: the last non-blank line that is not the
  # INSTRUMENTATION_CODE trailer. Success must be that exact summary, so output
  # that merely contains "OK" somewhere is not accepted.
  local last_line
  last_line="$(awk 'NF && $0 !~ /^INSTRUMENTATION_CODE:/ { last = $0 } END { print last }' <<<"$normalized")"

  if [[ ! "$last_line" =~ ^OK\ \(([0-9]+)\ tests?\)$ ]]; then
    echo "FAIL: no terminal AndroidJUnitRunner success summary; last result line was '${last_line}'" >&2
    return 1
  fi

  local actual="${BASH_REMATCH[1]}"
  if [[ "$actual" -eq 0 ]]; then
    echo "FAIL: runner reported zero tests" >&2
    return 1
  fi
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL: expected ${expected} passing test(s), runner reported ${actual}" >&2
    return 1
  fi

  echo "PASS: instrumentation reported OK (${actual} test(s))"
  return 0
}

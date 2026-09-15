#!/usr/bin/env bash
# ── test-sync-contract.sh ─────────────────────────────────────────────────────
# Hermetic contract tests for the locked payload recovery path.
#
# Invariants this suite keeps:
#   NETWORK_REQUIRED_FOR_UNIT_TEST = FALSE
#   SIBLING_FORTWEB_REQUIRED       = FALSE
#   PAYLOAD_MUTATION               = FALSE
#
# Positive cases use `--print-plan`, which is side-effect free. Negative cases
# fail before any build, import, or payload work runs. The suite therefore needs
# no FortWeb checkout, no network, and never touches app/src/main/assets/payload.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SYNC_SCRIPT="${REPO_ROOT}/sync-payload.sh"
BUILDER_SCRIPT="${REPO_ROOT}/scripts/build-canonical-fortweb-package.sh"
LOCK_READER="${REPO_ROOT}/tools/read-fortweb-runtime-lock.mjs"
PASS=0
FAIL=0
TMP_DIRS=()

cleanup() {
  local d
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    if [[ -n "${d}" && -d "${d}" ]]; then
      rm -rf "${d}"
    fi
  done
  return 0
}
trap cleanup EXIT

new_tmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("${d}")
  printf '%s' "${d}"
}

# A portable fingerprint of the staged payload, used to prove the suite does not
# mutate it, whether or not a payload happens to be staged already.
payload_state() {
  local d="${REPO_ROOT}/app/src/main/assets/payload"
  if [[ ! -e "${d}" ]]; then
    printf 'absent'
    return
  fi
  { find "${d}" -type f | sort; find "${d}" -type f -exec wc -c {} + | tail -1; } | cksum
}

ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Both failure and a specific message are required.
expect_fail_msg() {
  local desc="$1" needle="$2" out rc
  shift 2
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [[ ${rc} -eq 0 ]]; then
    bad "${desc} (expected failure, got success)"
    return
  fi
  if printf '%s' "${out}" | grep -qF -- "${needle}"; then
    ok "${desc}"
  else
    bad "${desc} (expected '${needle}', got: ${out})"
  fi
}

expect_fail() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    bad "${desc} (expected failure, got success)"
  else
    ok "${desc}"
  fi
}

expect_ok() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "${desc}"
  else
    bad "${desc} (expected success)"
  fi
}

expect_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
    ok "${desc}"
  else
    bad "${desc} (missing '${needle}')"
  fi
}

expect_absent() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
    bad "${desc} (unexpected '${needle}')"
  else
    ok "${desc}"
  fi
}

echo "=== locked payload recovery contract tests ==="
echo ""

PAYLOAD_BEFORE="$(payload_state)"

# ── Lock authority ────────────────────────────────────────────────────────────

LOCK_COMMIT="$(node "${LOCK_READER}" | sed -n 's/^LOCK_COMMIT=//p')"
if [[ "${LOCK_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  ok "real lock yields a 40-hex commit (${LOCK_COMMIT})"
else
  bad "real lock did not yield a 40-hex commit (got '${LOCK_COMMIT}')"
fi

FIXTURES="$(new_tmp)"
printf '%s' '{"schema":"wrong","repository":"keri-foundation/fortweb","commit":"'"${LOCK_COMMIT}"'"}' > "${FIXTURES}/bad-schema.json"
printf '%s' '{"schema":"fortoid.fortweb-runtime-lock.v1","repository":"evil/other","commit":"'"${LOCK_COMMIT}"'"}' > "${FIXTURES}/bad-repo.json"
printf '%s' '{"schema":"fortoid.fortweb-runtime-lock.v1","repository":"keri-foundation/fortweb","commit":"main"}' > "${FIXTURES}/bad-branch.json"
printf '%s' '{"schema":"fortoid.fortweb-runtime-lock.v1","repository":"keri-foundation/fortweb","commit":"002F4BE1BC167BA0DCE635DAB525FEDFACEE8B18"}' > "${FIXTURES}/bad-case.json"
printf '%s' '{"schema":"fortoid.fortweb-runtime-lock.v1","repository":"keri-foundation/fortweb","commit":"abc123"}' > "${FIXTURES}/bad-short.json"
printf '%s' 'not json at all' > "${FIXTURES}/bad-json.json"

expect_fail_msg "lock with a wrong schema is rejected" "lock schema must be" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-schema.json"
expect_fail_msg "lock with a wrong repository is rejected" "lock repository must be" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-repo.json"
expect_fail_msg "lock pinning a branch is rejected" "40-char lowercase SHA" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-branch.json"
expect_fail_msg "lock pinning an uppercase commit is rejected" "40-char lowercase SHA" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-case.json"
expect_fail_msg "lock pinning a short commit is rejected" "40-char lowercase SHA" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-short.json"
expect_fail_msg "lock that is not JSON is rejected" "could not read" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/bad-json.json"
expect_fail_msg "an absent lock file is rejected" "could not read" \
  node "${LOCK_READER}" --lock-file "${FIXTURES}/absent.json"
expect_fail_msg "an unknown lock reader argument is rejected" "unknown argument" \
  node "${LOCK_READER}" --nope

# ── Single-authority drift guards ─────────────────────────────────────────────

for script_path in "${SYNC_SCRIPT}" "${BUILDER_SCRIPT}"; do
  script_name="$(basename "${script_path}")"
  # Comment lines are stripped: prose may legitimately mention a tool the script
  # does not depend on. Only the executable surface is guarded.
  script_code="$(grep -v '^[[:space:]]*#' "${script_path}" || true)"
  expect_contains "${script_name} uses the single lock reader" \
    "read-fortweb-runtime-lock.mjs" "${script_code}"
  expect_absent "${script_name} does not parse JSON itself" "json.load" "${script_code}"
  expect_absent "${script_name} adds no jq dependency" "jq " "${script_code}"
  expect_absent "${script_name} has no bash-4-only mapfile" "mapfile" "${script_code}"
done

# Only sync-payload.sh performs the import, so only it must bind the lock there.
SYNC_CODE="$(grep -v '^[[:space:]]*#' "${SYNC_SCRIPT}" || true)"
expect_contains "sync-payload binds the importer to the locked commit" \
  "--expected-fortweb-commit" "${SYNC_CODE}"

# ── Argument and mode matrix ──────────────────────────────────────────────────

expect_fail_msg "no arguments prints usage" "Usage:" "${SYNC_SCRIPT}"
expect_fail_msg "--package without a value fails" "--package requires an explicit value" \
  "${SYNC_SCRIPT}" --package
expect_fail_msg "--fortweb-dir without a value fails" "--fortweb-dir requires an explicit value" \
  "${SYNC_SCRIPT}" --fortweb-dir
expect_fail_msg "a nonexistent package fails" "package not found" \
  "${SYNC_SCRIPT}" --package "${FIXTURES}/nope.zip"
expect_fail_msg "a nonexistent checkout fails" "FortWeb checkout not found" \
  "${SYNC_SCRIPT}" --fortweb-dir "${FIXTURES}/nope"
expect_fail_msg "--fetch alone fails" "--fetch requires --locked" "${SYNC_SCRIPT}" --fetch
expect_fail_msg "--fetch --ref main fails" "--ref is not supported" \
  "${SYNC_SCRIPT}" --fetch --ref main
expect_fail_msg "--ref <sha> fails" "--ref is not supported" \
  "${SYNC_SCRIPT}" --ref "${LOCK_COMMIT}"
expect_fail_msg "package + local modes fail" "only one mode may be selected" \
  "${SYNC_SCRIPT}" --package "${FIXTURES}/a.zip" --fortweb-dir "${FIXTURES}/x"
expect_fail_msg "package + fetch modes fail" "only one mode may be selected" \
  "${SYNC_SCRIPT}" --package "${FIXTURES}/a.zip" --fetch --locked
expect_fail_msg "local + fetch modes fail" "only one mode may be selected" \
  "${SYNC_SCRIPT}" --fortweb-dir "${FIXTURES}/x" --fetch --locked
expect_fail_msg "--locked without --fetch fails" "--locked is only valid with --fetch" \
  "${SYNC_SCRIPT}" --package "${FIXTURES}/a.zip" --locked
expect_fail_msg "an unknown argument fails" "unknown argument" "${SYNC_SCRIPT}" --bogus

# Non-git checkout: rejected before any producer work.
NON_GIT="$(new_tmp)"
expect_fail_msg "a non-git checkout fails" "is not a Git checkout" \
  "${SYNC_SCRIPT}" --fortweb-dir "${NON_GIT}"

# Checkout at the wrong revision: rejected before any producer work.
WRONG_REV="$(new_tmp)"
git -C "${WRONG_REV}" init -q
git -C "${WRONG_REV}" -c user.email=contract@test -c user.name=contract commit -q --allow-empty -m fixture
expect_fail_msg "a checkout at the wrong revision fails" "not at the locked revision" \
  "${SYNC_SCRIPT}" --fortweb-dir "${WRONG_REV}"

# ── Valid modes resolve to a plan ─────────────────────────────────────────────

expect_ok "package mode resolves to a plan" \
  "${SYNC_SCRIPT}" --package "${FIXTURES}/any.zip" --print-plan
expect_ok "fetch --locked resolves to a plan" \
  "${SYNC_SCRIPT}" --fetch --locked --print-plan
expect_ok "local mode resolves to a plan" \
  "${SYNC_SCRIPT}" --fortweb-dir /nonexistent-anywhere --print-plan

# ── Producer sequence plan ────────────────────────────────────────────────────

echo ""
echo "── Canonical producer plan ──"
BUILDER_PLAN="$(bash "${BUILDER_SCRIPT}" --fortweb-dir /nonexistent-anywhere --print-plan 2>&1)"

expect_contains "plan runs npm ci" "npm ci" "${BUILDER_PLAN}"
expect_contains "plan acquires the reviewed runtime source" "acquire_runtime_source.py" "${BUILDER_PLAN}"
expect_contains "plan pins the reviewed source URL" \
  "runtime-source-pyodide-314-hio-0.7.20-20260910/runtime-source.tar.gz" "${BUILDER_PLAN}"
expect_contains "plan pins the archive digest" \
  "394db70ecbed6e5718e6ec0afbcb43eaf6384e2ab78218e55067ec9e5d83fb34" "${BUILDER_PLAN}"
expect_contains "plan pins the manifest digest" \
  "371ef8cb8c6641b68afe6799931678435e2a629dcf4aa7ba2e344efab5a10f32" "${BUILDER_PLAN}"
expect_contains "plan builds the runtime" "npm run build:runtime" "${BUILDER_PLAN}"
expect_contains "plan packages the runtime" "npm run package:runtime" "${BUILDER_PLAN}"
expect_contains "plan passes --runtime-dir" "--runtime-dir dist/runtime" "${BUILDER_PLAN}"
expect_contains "plan passes --source-manifest" "--source-manifest " "${BUILDER_PLAN}"
expect_contains "plan passes --source-manifest-sha256" "--source-manifest-sha256 " "${BUILDER_PLAN}"
expect_contains "plan passes --python" "--python python3" "${BUILDER_PLAN}"
expect_contains "plan passes --ref" "--ref refs/heads/pyodide-314-runtime" "${BUILDER_PLAN}"
expect_contains "plan passes --output-dir" "--output-dir" "${BUILDER_PLAN}"
expect_contains "plan requires exactly one ZIP" "require-exactly-one-zip" "${BUILDER_PLAN}"
expect_contains "plan publishes the package path contract" "PACKAGE_PATH=" "${BUILDER_PLAN}"

expect_absent "plan never runs the removed test:fast script" "test:fast" "${BUILDER_PLAN}"
expect_absent "plan never calls package-runtime.mjs bare" \
  "node tools/package-runtime.mjs" "${BUILDER_PLAN}"
expect_absent "plan never assumes .tmp/runtime-packages" ".tmp/runtime-packages" "${BUILDER_PLAN}"
expect_absent "plan never pins a mutable producer branch" "--ref main" "${BUILDER_PLAN}"

# ── sync-payload plan binding ─────────────────────────────────────────────────

echo ""
echo "── sync-payload mode plans ──"
PKG_PLAN="$(bash "${SYNC_SCRIPT}" --package "${FIXTURES}/any.zip" --print-plan 2>&1)"
LOCAL_PLAN="$(bash "${SYNC_SCRIPT}" --fortweb-dir /nonexistent-anywhere --print-plan 2>&1)"
FETCH_PLAN="$(bash "${SYNC_SCRIPT}" --fetch --locked --print-plan 2>&1)"

expect_contains "package plan binds the lock" "locked_commit=${LOCK_COMMIT}" "${PKG_PLAN}"
expect_contains "package plan imports with the locked commit" \
  "--expected-fortweb-commit ${LOCK_COMMIT}" "${PKG_PLAN}"
expect_contains "package plan validates the staged payload" "validate-staged-payload.mjs" "${PKG_PLAN}"
expect_contains "package plan verifies the staged payload" "verify-packaged-runtime.mjs" "${PKG_PLAN}"
expect_contains "package plan selects package mode" "PLAN mode=package" "${PKG_PLAN}"
expect_absent "package mode performs no producer build" "npm ci" "${PKG_PLAN}"
expect_absent "package mode performs no fetch" "git fetch" "${PKG_PLAN}"

expect_contains "local plan delegates to the canonical producer" \
  "build-canonical-fortweb-package.sh" "${LOCAL_PLAN}"
expect_contains "local plan requires the locked revision" \
  "checkout must be at the locked revision" "${LOCAL_PLAN}"
expect_contains "local plan imports with the locked commit" \
  "--expected-fortweb-commit ${LOCK_COMMIT}" "${LOCAL_PLAN}"

expect_contains "fetch plan fetches the locked commit" "git fetch --depth 1" "${FETCH_PLAN}"
expect_contains "fetch plan fetches the locked sha" "${LOCK_COMMIT}" "${FETCH_PLAN}"
expect_contains "fetch plan verifies the fetched checkout" \
  "checkout_verify=HEAD must equal ${LOCK_COMMIT}" "${FETCH_PLAN}"
expect_contains "fetch plan delegates to the canonical producer" \
  "build-canonical-fortweb-package.sh" "${FETCH_PLAN}"
expect_contains "fetch plan runs the canonical producer sequence" "npm run build:runtime" "${FETCH_PLAN}"
expect_contains "fetch plan imports with the locked commit" \
  "--expected-fortweb-commit ${LOCK_COMMIT}" "${FETCH_PLAN}"
expect_absent "fetch plan contains no mutable ref" "refs/heads/main" "${FETCH_PLAN}"

# ── Purity ────────────────────────────────────────────────────────────────────

echo ""
echo "── Purity ──"
PAYLOAD_AFTER="$(payload_state)"
if [[ "${PAYLOAD_BEFORE}" == "${PAYLOAD_AFTER}" ]]; then
  ok "contract suite left the staged payload untouched (${PAYLOAD_BEFORE})"
else
  bad "contract suite modified the staged payload (before=${PAYLOAD_BEFORE} after=${PAYLOAD_AFTER})"
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi

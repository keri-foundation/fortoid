#!/usr/bin/env bash
# ── sync-payload.sh ───────────────────────────────────────────────────────────
#
# Stage the canonical FortWeb runtime package into the Android payload directory.
#
# The producer revision is never a parameter: config/fortweb-runtime.json is the
# only authority, and every mode is bound to it.
#
# Usage:
#   ./sync-payload.sh --package <fortweb-runtime.zip>
#   ./sync-payload.sh --fortweb-dir <checkout>
#   ./sync-payload.sh --fetch --locked
#
# Mutable refs are not supported. Binding a payload to a branch or tag
# reintroduces the drift the lock exists to prevent, so --ref is rejected.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="${REPO_ROOT}/config/fortweb-runtime.json"
LOCK_READER="${REPO_ROOT}/tools/read-fortweb-runtime-lock.mjs"
IMPORTER="${REPO_ROOT}/tools/import-fortweb-runtime-package.mjs"
BUILDER="${REPO_ROOT}/scripts/build-canonical-fortweb-package.sh"
PAYLOAD_REL="app/src/main/assets/payload"
FORTWEB_REMOTE="https://github.com/keri-foundation/fortweb.git"

MODE=""
PACKAGE_ZIP=""
FORTWEB_DIR=""
DO_LOCKED=false
PRINT_PLAN=false
TEMP_ROOT=""
LOCK_COMMIT=""

cleanup() {
  if [[ -n "${TEMP_ROOT}" && -d "${TEMP_ROOT}" ]]; then
    rm -rf "${TEMP_ROOT}"
  fi
  return 0
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage: ./sync-payload.sh --package <fortweb-runtime.zip>
       ./sync-payload.sh --fortweb-dir <checkout>
       ./sync-payload.sh --fetch --locked

Stage the canonical FortWeb runtime package into the Android payload directory.

Modes (exactly one):
  --package <zip>        import an already-produced canonical package
  --fortweb-dir <dir>    build from a local checkout at the locked revision
  --fetch --locked       fetch the locked revision, then build

Options:
  --print-plan           print what would run, without running it
  -h, --help             show this help

The FortWeb producer revision comes from config/fortweb-runtime.json and is not
a parameter. --ref is not supported: mutable refs are rejected.
EOF
  exit "${1:-1}"
}

select_mode() {
  if [[ -n "${MODE}" ]]; then
    echo "error: only one mode may be selected (already ${MODE}, also $1)" 1>&2
    usage
  fi
  MODE="$1"
}

# Reject a flag in value position so no argument is silently consumed as a path.
require_value() {
  local flag="$1" value="${2:-}"
  if [[ -z "${value}" || "${value:0:2}" == "--" ]]; then
    echo "error: ${flag} requires an explicit value" 1>&2
    usage
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      require_value "$1" "${2:-}"
      select_mode package
      PACKAGE_ZIP="$2"
      shift 2
      ;;
    --fortweb-dir)
      require_value "$1" "${2:-}"
      select_mode local
      FORTWEB_DIR="$2"
      shift 2
      ;;
    --fetch)
      select_mode fetch
      shift
      ;;
    --locked)
      DO_LOCKED=true
      shift
      ;;
    --ref)
      echo "error: --ref is not supported" 1>&2
      echo "       The FortWeb producer revision comes from config/fortweb-runtime.json." 1>&2
      echo "       Use --fetch --locked to fetch the locked revision." 1>&2
      exit 1
      ;;
    --print-plan)
      PRINT_PLAN=true
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "error: unknown argument: $1" 1>&2
      usage
      ;;
  esac
done

# ── Mode validation ───────────────────────────────────────────────────────────

if [[ -z "${MODE}" ]]; then
  echo "error: no mode selected" 1>&2
  usage
fi

if [[ "${MODE}" == "fetch" ]]; then
  if ! ${DO_LOCKED}; then
    echo "error: --fetch requires --locked" 1>&2
    echo "       Fetching a mutable ref is not supported." 1>&2
    exit 1
  fi
elif ${DO_LOCKED}; then
  echo "error: --locked is only valid with --fetch" 1>&2
  exit 1
fi

# ── Lock authority ────────────────────────────────────────────────────────────
# Every mode is bound to config/fortweb-runtime.json. There is no override and
# no mutable-ref fallback.

command -v node >/dev/null 2>&1 || { echo "error: node is required" 1>&2; exit 1; }
[[ -f "${LOCK_FILE}" ]] || { echo "error: FortWeb runtime lock missing: ${LOCK_FILE}" 1>&2; exit 1; }

LOCK_OUTPUT="$(node "${LOCK_READER}" --lock-file "${LOCK_FILE}")" || exit 1
while IFS= read -r line; do
  case "${line}" in
    LOCK_COMMIT=*) LOCK_COMMIT="${line#LOCK_COMMIT=}" ;;
  esac
done <<< "${LOCK_OUTPUT}"
[[ -n "${LOCK_COMMIT}" ]] || { echo "error: lock reader did not return a commit" 1>&2; exit 1; }

# ── Shared steps ──────────────────────────────────────────────────────────────

make_temp() {
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fortoid-payload-sync.XXXXXX")"
}

print_import_plan() {
  echo "PLAN import=cwd=${REPO_ROOT} cmd=node tools/import-fortweb-runtime-package.mjs --expected-fortweb-commit ${LOCK_COMMIT} $1"
  echo "PLAN import_acceptance=cwd=${REPO_ROOT} cmd=node tools/validate-staged-payload.mjs and node tools/verify-packaged-runtime.mjs ${PAYLOAD_REL} run by the importer inside its rollback transaction"
}

import_and_verify() {
  local zip="$1"
  echo "[sync-payload] importing package for locked commit ${LOCK_COMMIT}"
  # The importer runs both acceptance validators against the activated payload
  # inside its own rollback transaction. A rejected package therefore cannot
  # replace the previous payload, and cannot be left active after a failure.
  echo "[sync-payload] import performs transactional acceptance validation:"
  echo "[sync-payload]   staged payload contract: tools/validate-staged-payload.mjs"
  echo "[sync-payload]   packaged runtime bytes: tools/verify-packaged-runtime.mjs"
  node "${IMPORTER}" --expected-fortweb-commit "${LOCK_COMMIT}" "${zip}"
}

# The canonical producer sequence lives in
# scripts/build-canonical-fortweb-package.sh. Its stdout is the machine-readable
# contract: exactly one PACKAGE_PATH= line, and nothing else is parsed.
run_builder() {
  local checkout="$1" out_dir="$2" log_file status pkg_count pkg_line pkg_path
  log_file="${TEMP_ROOT}/producer.log"

  set +e
  bash "${BUILDER}" --fortweb-dir "${checkout}" --output-dir "${out_dir}" 2>&1 | tee "${log_file}" >&2
  status="${PIPESTATUS[0]}"
  set -e

  if [[ "${status}" -ne 0 ]]; then
    echo "error: canonical FortWeb package build failed (exit ${status})" 1>&2
    exit "${status}"
  fi

  pkg_count="$(grep -c '^PACKAGE_PATH=' "${log_file}" || true)"
  if [[ "${pkg_count}" != "1" ]]; then
    echo "error: expected exactly one PACKAGE_PATH line from the producer, found '${pkg_count}'" 1>&2
    exit 1
  fi

  pkg_line="$(grep '^PACKAGE_PATH=' "${log_file}")"
  pkg_path="${pkg_line#PACKAGE_PATH=}"
  [[ -f "${pkg_path}" ]] || { echo "error: producer reported a missing package: ${pkg_path}" 1>&2; exit 1; }
  printf '%s' "${pkg_path}"
}

# ── Mode A: import an already-produced canonical package ──────────────────────

if [[ "${MODE}" == "package" ]]; then
  if ${PRINT_PLAN}; then
    echo "PLAN mode=package"
    echo "PLAN lock_file=${LOCK_FILE}"
    echo "PLAN locked_commit=${LOCK_COMMIT}"
    print_import_plan "${PACKAGE_ZIP}"
    exit 0
  fi

  [[ -f "${PACKAGE_ZIP}" ]] || { echo "error: package not found: ${PACKAGE_ZIP}" 1>&2; exit 1; }

  import_and_verify "${PACKAGE_ZIP}"
  echo "[sync-payload] payload import complete"
  exit 0
fi

# ── Mode B: build from a local checkout at the locked revision ────────────────

if [[ "${MODE}" == "local" ]]; then
  if ${PRINT_PLAN}; then
    echo "PLAN mode=fortweb-dir"
    echo "PLAN lock_file=${LOCK_FILE}"
    echo "PLAN producer_impl=${BUILDER}"
    bash "${BUILDER}" --fortweb-dir "${FORTWEB_DIR}" --print-plan
    print_import_plan "<package-from-build>"
    exit 0
  fi

  [[ -d "${FORTWEB_DIR}" ]] || { echo "error: FortWeb checkout not found at ${FORTWEB_DIR}" 1>&2; exit 1; }

  make_temp
  built_zip="$(run_builder "${FORTWEB_DIR}" "${TEMP_ROOT}/runtime-package")"
  import_and_verify "${built_zip}"
  echo "[sync-payload] payload import complete"
  exit 0
fi

# ── Mode C: fetch the locked revision, then build ─────────────────────────────

if ${PRINT_PLAN}; then
  echo "PLAN mode=fetch-locked"
  echo "PLAN lock_file=${LOCK_FILE}"
  echo "PLAN locked_commit=${LOCK_COMMIT}"
  echo "PLAN fetch=git fetch --depth 1 ${FORTWEB_REMOTE} ${LOCK_COMMIT}"
  echo "PLAN checkout_verify=HEAD must equal ${LOCK_COMMIT}"
  echo "PLAN producer_impl=${BUILDER}"
  bash "${BUILDER}" --fortweb-dir "<fetched-checkout>" --print-plan
  print_import_plan "<package-from-build>"
  exit 0
fi

make_temp
FORTWEB_DIR="${TEMP_ROOT}/fortweb"

echo "[sync-payload] fetching locked commit ${LOCK_COMMIT} from ${FORTWEB_REMOTE}"
git init -q "${FORTWEB_DIR}"
git -C "${FORTWEB_DIR}" remote add origin "${FORTWEB_REMOTE}"
git -C "${FORTWEB_DIR}" fetch --depth 1 origin "${LOCK_COMMIT}"
git -C "${FORTWEB_DIR}" checkout -q --detach FETCH_HEAD

FETCHED_COMMIT="$(git -C "${FORTWEB_DIR}" rev-parse HEAD)"
if [[ "${FETCHED_COMMIT}" != "${LOCK_COMMIT}" ]]; then
  echo "error: fetched commit ${FETCHED_COMMIT} does not match the lock ${LOCK_COMMIT}" 1>&2
  exit 1
fi
echo "[sync-payload] fetched checkout verified at ${FETCHED_COMMIT}"

built_zip="$(run_builder "${FORTWEB_DIR}" "${TEMP_ROOT}/runtime-package")"
import_and_verify "${built_zip}"
echo "[sync-payload] payload import complete"

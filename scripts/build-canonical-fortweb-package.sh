#!/usr/bin/env bash
# ── build-canonical-fortweb-package.sh ────────────────────────────────────────
#
# Produce exactly one canonical FortWeb runtime package from the LOCKED producer
# revision. This is the single shell implementation of the producer build/package
# sequence, shared by:
#
#   sync-payload.sh                                  (developer recovery)
#   .github/actions/prepare-fortweb-runtime/action.yml   (CI)
#
# so the two paths cannot drift apart again.
#
# The producer identity is never a parameter: it comes from
# config/fortweb-runtime.json, which is the sole authority.
#
# Usage:
#   scripts/build-canonical-fortweb-package.sh \
#     --fortweb-dir <checkout> \
#     --output-dir <fresh-output-dir>
#
#   scripts/build-canonical-fortweb-package.sh --fortweb-dir <checkout> --print-plan
#
# --print-plan emits the exact sequence that would run, without executing any of
# it (no network, no npm, no Python, no filesystem mutation). It exists so the
# contract can be tested hermetically in CI.
#
# On success the last stdout line is:
#   PACKAGE_PATH=<absolute path to the single canonical ZIP>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${REPO_ROOT}/config/fortweb-runtime.json"

# Reviewed runtime-source pin. These values are the reviewed contract and must not
# be changed here; they must agree with the FortWeb producer's declared pin.
SOURCE_URL="https://github.com/keri-foundation/fortweb/releases/download/runtime-source-pyodide-314-hio-0.7.20-20260910/runtime-source.tar.gz"
SOURCE_ARCHIVE_SHA256="394db70ecbed6e5718e6ec0afbcb43eaf6384e2ab78218e55067ec9e5d83fb34"
SOURCE_MANIFEST_SHA256="371ef8cb8c6641b68afe6799931678435e2a629dcf4aa7ba2e344efab5a10f32"
SOURCE_MANIFEST_REL="build/runtime-source/manifest.json"
PACKAGE_REF="refs/heads/pyodide-314-runtime"

FORTWEB_DIR=""
OUTPUT_DIR=""
PRINT_PLAN=false

usage() {
  cat <<'EOF'
Usage: scripts/build-canonical-fortweb-package.sh --fortweb-dir <checkout> --output-dir <fresh-dir>
       scripts/build-canonical-fortweb-package.sh --fortweb-dir <checkout> --print-plan

The FortWeb revision is read from config/fortweb-runtime.json and must match the
checkout exactly. The output directory must not already exist.
EOF
  exit 1
}

log() { printf '[build-canonical-fortweb-package] %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fortweb-dir) FORTWEB_DIR="${2:-}"; shift 2 ;;
    --output-dir)  OUTPUT_DIR="${2:-}"; shift 2 ;;
    --print-plan)  PRINT_PLAN=true; shift ;;
    -h|--help)     usage ;;
    *)             die "unknown argument: $1" ;;
  esac
done

if ! ${PRINT_PLAN}; then
  [[ -n "${FORTWEB_DIR}" ]] || die "--fortweb-dir is required"
  [[ -n "${OUTPUT_DIR}" ]] || die "--output-dir is required"
fi

# `--print-plan` only describes the sequence, so it needs neither a checkout nor
# an output directory. Placeholders keep the printed argv honest.
DIR_DISPLAY="${FORTWEB_DIR:-<fortweb-dir>}"
OUTPUT_DISPLAY="${OUTPUT_DIR:-<output-dir>}"

# ── Lock authority ────────────────────────────────────────────────────────────

[[ -f "${LOCK_FILE}" ]] || die "FortWeb runtime lock missing: ${LOCK_FILE}"

# The lock reader is the single lock-parsing implementation, shared with
# sync-payload.sh and the CI action. Node is used rather than jq so the developer
# recovery path gains no new external dependency, and no bash-4-only builtins are
# required (macOS ships bash 3.2).
command -v node >/dev/null 2>&1 || die "node is required"

LOCK_SCHEMA=""
LOCK_REPOSITORY=""
LOCK_COMMIT=""
LOCK_OUTPUT="$(node "${REPO_ROOT}/tools/read-fortweb-runtime-lock.mjs" --lock-file "${LOCK_FILE}")" \
  || die "FortWeb runtime lock is invalid: ${LOCK_FILE}"

while IFS= read -r line; do
  case "${line}" in
    LOCK_SCHEMA=*)     LOCK_SCHEMA="${line#LOCK_SCHEMA=}" ;;
    LOCK_REPOSITORY=*) LOCK_REPOSITORY="${line#LOCK_REPOSITORY=}" ;;
    LOCK_COMMIT=*)     LOCK_COMMIT="${line#LOCK_COMMIT=}" ;;
  esac
done <<< "${LOCK_OUTPUT}"

[[ -n "${LOCK_SCHEMA}" && -n "${LOCK_REPOSITORY}" && -n "${LOCK_COMMIT}" ]] \
  || die "lock reader did not return schema, repository, and commit"

if ${PRINT_PLAN}; then
  cat <<EOF
PLAN lock_file=${LOCK_FILE}
PLAN locked_commit=${LOCK_COMMIT}
PLAN checkpoint=checkout must be at the locked revision
PLAN npm_ci=cwd=${DIR_DISPLAY} cmd=npm ci
PLAN acquire_source=cwd=${DIR_DISPLAY} cmd=python3 scripts/acquire_runtime_source.py --url ${SOURCE_URL} --sha256 ${SOURCE_ARCHIVE_SHA256} --manifest-sha256 ${SOURCE_MANIFEST_SHA256} --output build/runtime-source
PLAN install_build_tools=cwd=${DIR_DISPLAY} cmd=python3 -m pip install --disable-pip-version-check --no-index --no-deps build/runtime-source/wheelhouse/packaging-26.1-py3-none-any.whl build/runtime-source/wheelhouse/setuptools-83.0.0-py3-none-any.whl build/runtime-source/wheelhouse/wheel-0.47.0-py3-none-any.whl
PLAN build_runtime=cwd=${DIR_DISPLAY} env=FORTWEB_RUNTIME_SOURCE_MANIFEST=${SOURCE_MANIFEST_REL} FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256=${SOURCE_MANIFEST_SHA256} cmd=npm run build:runtime
PLAN package_runtime=cwd=${DIR_DISPLAY} env=FORTWEB_RUNTIME_SOURCE_MANIFEST=${SOURCE_MANIFEST_REL} FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256=${SOURCE_MANIFEST_SHA256} cmd=npm run package:runtime -- --runtime-dir dist/runtime --source-manifest ${SOURCE_MANIFEST_REL} --source-manifest-sha256 ${SOURCE_MANIFEST_SHA256} --python python3 --ref ${PACKAGE_REF} --output-dir ${OUTPUT_DISPLAY}
PLAN select_package=require-exactly-one-zip
PLAN emit=PACKAGE_PATH=<absolute-zip>
EOF
  exit 0
fi

[[ -d "${FORTWEB_DIR}/.git" ]] || die "${FORTWEB_DIR} is not a Git checkout"

ACTUAL_COMMIT="$(git -C "${FORTWEB_DIR}" rev-parse HEAD)"
log "locked producer commit: ${LOCK_COMMIT}"
log "checkout commit:        ${ACTUAL_COMMIT}"

if [[ "${ACTUAL_COMMIT}" != "${LOCK_COMMIT}" ]]; then
  die "FortWeb checkout is not at the locked revision (expected ${LOCK_COMMIT}, got ${ACTUAL_COMMIT})"
fi

command -v python3 >/dev/null 2>&1 || die "python3 is required"

# The producer creates the output directory itself (non-recursive mkdir), so the
# parent must exist and the directory itself must not.
OUTPUT_PARENT="$(dirname "${OUTPUT_DIR}")"
mkdir -p "${OUTPUT_PARENT}"
[[ ! -e "${OUTPUT_DIR}" ]] || die "output directory already exists: ${OUTPUT_DIR}"

# ── Canonical producer sequence ───────────────────────────────────────────────
# Errors are surfaced, never redirected away: a swallowed producer failure is how
# the previous developer path became undiagnosable.

log "installing FortWeb dependencies"
(cd "${FORTWEB_DIR}" && npm ci)

log "acquiring reviewed runtime source"
(cd "${FORTWEB_DIR}" && python3 scripts/acquire_runtime_source.py \
  --url "${SOURCE_URL}" \
  --sha256 "${SOURCE_ARCHIVE_SHA256}" \
  --manifest-sha256 "${SOURCE_MANIFEST_SHA256}" \
  --output build/runtime-source)

log "installing verified Python build tools"
(cd "${FORTWEB_DIR}" && python3 -m pip install --disable-pip-version-check --no-index --no-deps \
  build/runtime-source/wheelhouse/packaging-26.1-py3-none-any.whl \
  build/runtime-source/wheelhouse/setuptools-83.0.0-py3-none-any.whl \
  build/runtime-source/wheelhouse/wheel-0.47.0-py3-none-any.whl)

log "building runtime"
(cd "${FORTWEB_DIR}" && \
  FORTWEB_RUNTIME_SOURCE_MANIFEST="${SOURCE_MANIFEST_REL}" \
  FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256="${SOURCE_MANIFEST_SHA256}" \
  npm run build:runtime)

log "producing canonical package"
(cd "${FORTWEB_DIR}" && \
  FORTWEB_RUNTIME_SOURCE_MANIFEST="${SOURCE_MANIFEST_REL}" \
  FORTWEB_RUNTIME_SOURCE_MANIFEST_SHA256="${SOURCE_MANIFEST_SHA256}" \
  npm run package:runtime -- \
    --runtime-dir dist/runtime \
    --source-manifest "${SOURCE_MANIFEST_REL}" \
    --source-manifest-sha256 "${SOURCE_MANIFEST_SHA256}" \
    --python python3 \
    --ref "${PACKAGE_REF}" \
    --output-dir "${OUTPUT_DIR}")

# ── Exact package selection ───────────────────────────────────────────────────

PACKAGE_COUNT="$(find "${OUTPUT_DIR}" -maxdepth 1 -name '*.zip' -type f | wc -l | tr -d ' ')"
[[ "${PACKAGE_COUNT}" -eq 1 ]] \
  || die "expected exactly one canonical runtime ZIP in ${OUTPUT_DIR}, found ${PACKAGE_COUNT}"

PACKAGE_PATH="$(find "${OUTPUT_DIR}" -maxdepth 1 -name '*.zip' -type f -print -quit)"

log "locked producer commit: ${LOCK_COMMIT}"
log "package: ${PACKAGE_PATH}"
printf 'PACKAGE_PATH=%s\n' "${PACKAGE_PATH}"

#!/usr/bin/env bash
# ── sync-payload.sh ───────────────────────────────────────────────────────────
#
# Stage the canonical FortWeb runtime artifact into the Android payload directory.
# The only supported input is FortWeb/dist/runtime — raw source trees are rejected.
#
# Usage:
#   ./sync-payload.sh --fortweb-dir <path>
#   ./sync-payload.sh --fetch --ref <commit-tag-or-branch> [--remote <git-url>]
#
# Local mode requires an explicit --fortweb-dir.
# Fetch mode requires an explicit --ref; fails without it.
# Fetch mode without --ref is never allowed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_PAYLOAD_DIR="${SCRIPT_DIR}/app/src/main/assets/payload"
FORTWEB_DIR=""
FORTWEB_REMOTE="https://github.com/keri-foundation/fortweb.git"
FORTWEB_REF=""
DO_FETCH=false
TEMP_ROOT=""

cleanup() {
  if [[ -n "${TEMP_ROOT}" && -d "${TEMP_ROOT}" ]]; then
    rm -rf "${TEMP_ROOT}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage: ./sync-payload.sh --fortweb-dir <path>
       ./sync-payload.sh --fetch --ref <commit-tag-or-branch> [--remote <git-url>]

Stage the canonical FortWeb runtime artifact into the Android payload directory.

Local mode:
  ./sync-payload.sh --fortweb-dir ../fortweb

Fetch mode:
  ./sync-payload.sh --fetch --ref main
  ./sync-payload.sh --fetch --ref abc123def
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fetch)
      DO_FETCH=true
      shift
      ;;
    --ref)
      FORTWEB_REF="$2"
      shift 2
      ;;
    --remote)
      FORTWEB_REMOTE="$2"
      shift 2
      ;;
    --fortweb-dir)
      FORTWEB_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "error: unknown argument: $1" 1>&2
      usage
      ;;
  esac
done

# ── Argument validation ───────────────────────────────────────────────────────

if $DO_FETCH; then
  if [[ -z "${FORTWEB_REF}" ]]; then
    echo "error: --fetch requires --ref <commit-tag-or-branch>" 1>&2
    echo "       Refusing to fetch without an explicit ref." 1>&2
    exit 1
  fi
else
  if [[ -z "${FORTWEB_DIR}" ]]; then
    echo "error: --fortweb-dir is required in local mode" 1>&2
    echo "       Usage: ./sync-payload.sh --fortweb-dir <path>" 1>&2
    exit 1
  fi
fi

# ── Fetch mode ────────────────────────────────────────────────────────────────

if $DO_FETCH; then
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fortweb-fetch.XXXXXX")"
  FORTWEB_DIR="${TEMP_ROOT}/fortweb"

  echo "[sync-payload] fetching FortWeb ref=${FORTWEB_REF} from ${FORTWEB_REMOTE}"
  git clone --depth 1 --branch "${FORTWEB_REF}" "${FORTWEB_REMOTE}" "${FORTWEB_DIR}" >/dev/null 2>&1
  FORTWEB_COMMIT="$(git -C "${FORTWEB_DIR}" rev-parse HEAD)"
  echo "[sync-payload] resolved ref=${FORTWEB_REF} → commit=${FORTWEB_COMMIT}"
fi

# ── FortWeb validation ────────────────────────────────────────────────────────

if [[ ! -d "${FORTWEB_DIR}" ]]; then
  echo "error: FortWeb directory not found at ${FORTWEB_DIR}" 1>&2
  exit 1
fi

if [[ ! -d "${FORTWEB_DIR}/.git" ]]; then
  echo "error: ${FORTWEB_DIR} is not a Git repository" 1>&2
  exit 1
fi

FORTWEB_COMMIT="$(git -C "${FORTWEB_DIR}" rev-parse HEAD)"
echo "[sync-payload] FortWeb commit=${FORTWEB_COMMIT}"

if [[ ! -f "${FORTWEB_DIR}/package-lock.json" ]]; then
  echo "error: package-lock.json missing in FortWeb checkout" 1>&2
  echo "       Run in FortWeb: npm ci" 1>&2
  exit 1
fi

# ── Build and test FortWeb runtime ────────────────────────────────────────────
# Local mode: assume dependencies are already installed and runtime is built.
# Fetch mode: install dependencies and build from scratch.

if $DO_FETCH; then
  echo "[sync-payload] installing FortWeb dependencies"
  (cd "${FORTWEB_DIR}" && npm ci) >/dev/null 2>&1

  echo "[sync-payload] typechecking FortWeb"
  (cd "${FORTWEB_DIR}" && npm run typecheck)

  echo "[sync-payload] building FortWeb runtime"
  (cd "${FORTWEB_DIR}" && npm run build:runtime)

  echo "[sync-payload] running FortWeb fast tests"
  (cd "${FORTWEB_DIR}" && npm run test:fast)
fi

# ── Verify dist/runtime exists ────────────────────────────────────────────────

if [[ ! -d "${FORTWEB_DIR}/dist/runtime" ]]; then
  echo "error: dist/runtime not found after FortWeb build" 1>&2
  exit 1
fi

if [[ ! -f "${FORTWEB_DIR}/dist/runtime/app/app/main.js" ]]; then
  echo "error: compiled main.js not found in dist/runtime" 1>&2
  exit 1
fi

if [[ ! -f "${FORTWEB_DIR}/dist/runtime/app/index.html" ]]; then
  echo "error: entry HTML not found in dist/runtime" 1>&2
  exit 1
fi

RUNTIME_FILE_COUNT="$(find "${FORTWEB_DIR}/dist/runtime" -type f | wc -l | tr -d ' ')"
echo "[sync-payload] FortWeb runtime: ${RUNTIME_FILE_COUNT} files"

# ── Generate FortWeb runtime package ZIP ──────────────────────────────────────

echo "[sync-payload] generating FortWeb runtime package ZIP"

FORTWEB_PACKAGE_ZIP="${TEMP_ROOT:-/tmp}/fortweb-runtime-${FORTWEB_COMMIT}.zip"

(cd "${FORTWEB_DIR}" && node tools/package-runtime.mjs) >/dev/null 2>&1

# Find the generated ZIP (FortWeb puts it under .tmp/runtime-packages/)
GENERATED_ZIP="$(ls -t "${FORTWEB_DIR}/.tmp/runtime-packages/"*.zip 2>/dev/null | head -1)"

if [[ -z "${GENERATED_ZIP}" || ! -f "${GENERATED_ZIP}" ]]; then
  echo "error: FortWeb package-runtime.mjs did not produce a ZIP" 1>&2
  exit 1
fi

echo "[sync-payload] FortWeb package ZIP: ${GENERATED_ZIP}"

# ── Import into Android payload ───────────────────────────────────────────────

echo "[sync-payload] importing runtime package into Android payload"

node "${SCRIPT_DIR}/tools/import-fortweb-runtime-package.mjs" "${GENERATED_ZIP}"

echo "[sync-payload] payload import complete"
echo "[sync-payload] done"

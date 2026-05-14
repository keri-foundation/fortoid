#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORT_IOS_DIR="${SCRIPT_DIR}/../Fort-ios"
DEFAULT_FORTWEB_DIR="${SCRIPT_DIR}/../fortweb"
FORTWEB_DIR="${FORTWEB_DIR:-${DEFAULT_FORTWEB_DIR}}"
FORTWEB_REMOTE="${FORTWEB_REMOTE:-https://github.com/keri-foundation/fortweb.git}"
FORTWEB_REF="${FORTWEB_REF:-214643f4fa907061334c09c8297c4d1e59f18f45}"
WRAPPER_PAYLOAD_DIR="${SCRIPT_DIR}/app/src/main/assets/payload"
BRIDGE_CONTRACT_SRC="${FORT_IOS_DIR}/generated/BridgeContract.kt"
BRIDGE_CONTRACT_DEST_DIR="${SCRIPT_DIR}/app/src/main/java/org/kerifoundation/fort/bridge"
BRIDGE_CONTRACT_DEST="${BRIDGE_CONTRACT_DEST_DIR}/BridgeContract.kt"
FORTWEB_MANIFEST_TOOL="${FORT_IOS_DIR}/tools/gen-fortweb-bundle-manifest.mjs"
PAYLOAD_VALIDATOR="${FORT_IOS_DIR}/tools/validate-mobile-payload.mjs"

FETCH_MODE=0
TEMP_ROOT=""
FORTWEB_SOURCE_DIR=""

usage() {
  cat <<'EOF'
Usage: ./sync-payload.sh [--fetch] [--ref <commit-or-tag-or-branch>] [--remote <git-url>] [--fortweb-dir <path>]

Defaults to a sibling FortWeb checkout at ../fortweb.

Options:
  --fetch                 Download a temporary FortWeb checkout instead of using ../fortweb.
  --ref <ref>             Commit, tag, or branch to fetch when --fetch is used.
                          Default: 214643f4fa907061334c09c8297c4d1e59f18f45.
  --remote <git-url>      Git remote used with --fetch.
  --fortweb-dir <path>    Explicit local FortWeb checkout path.
  --help                  Show this message.
EOF
}

cleanup() {
  if [[ -n "${TEMP_ROOT}" && -d "${TEMP_ROOT}" ]]; then
    rm -rf "${TEMP_ROOT}"
  fi
}

trap cleanup EXIT

require_option_value() {
  local option_name="$1"

  if [[ $# -lt 2 || -z "${2-}" ]]; then
    echo "error: ${option_name} requires a value" 1>&2
    usage 1>&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fetch)
      FETCH_MODE=1
      ;;
    --ref)
      require_option_value "$1" "${2-}"
      FORTWEB_REF="$2"
      shift
      ;;
    --remote)
      require_option_value "$1" "${2-}"
      FORTWEB_REMOTE="$2"
      shift
      ;;
    --fortweb-dir)
      require_option_value "$1" "${2-}"
      FORTWEB_DIR="$2"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" 1>&2
      usage 1>&2
      exit 1
      ;;
  esac
  shift
done

require_file() {
  local file_path="$1"
  local label="$2"

  if [[ ! -f "${file_path}" ]]; then
    echo "error: ${label} missing at ${file_path}" 1>&2
    exit 1
  fi
}

require_dir() {
  local dir_path="$1"
  local label="$2"

  if [[ ! -d "${dir_path}" ]]; then
    echo "error: ${label} missing at ${dir_path}" 1>&2
    exit 1
  fi
}

resolve_fortweb_source() {
  if [[ "${FETCH_MODE}" -eq 1 ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo "error: git is required for --fetch mode" 1>&2
      exit 1
    fi

    TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fortweb-fetch.XXXXXX")"
    FORTWEB_SOURCE_DIR="${TEMP_ROOT}/fortweb"

    echo "[sync-payload] fetching FortWeb ref=${FORTWEB_REF} from ${FORTWEB_REMOTE}"
    mkdir -p "${FORTWEB_SOURCE_DIR}"
    git -C "${FORTWEB_SOURCE_DIR}" init >/dev/null 2>&1
    git -C "${FORTWEB_SOURCE_DIR}" remote add origin "${FORTWEB_REMOTE}" >/dev/null 2>&1 || true
    if ! git -C "${FORTWEB_SOURCE_DIR}" fetch --depth 1 origin "${FORTWEB_REF}" >/dev/null 2>&1; then
      echo "error: failed to fetch FortWeb remote ${FORTWEB_REMOTE} at ref ${FORTWEB_REF}" 1>&2
      echo "       Use a valid commit, tag, or branch with --ref, or point to a local checkout with --fortweb-dir." 1>&2
      exit 1
    fi
    git -C "${FORTWEB_SOURCE_DIR}" checkout --detach FETCH_HEAD >/dev/null 2>&1
    return
  fi

  if [[ -d "${FORTWEB_DIR}" ]]; then
    FORTWEB_SOURCE_DIR="${FORTWEB_DIR}"
    return
  fi

  echo "error: expected shared FortWeb checkout at ${FORTWEB_DIR}" 1>&2
  echo "       Run './sync-payload.sh --fetch --ref ${FORTWEB_REF}' to fetch a temporary payload source." 1>&2
  exit 1
}

resolve_fortweb_source

require_file "${FORTWEB_SOURCE_DIR}/app/index.html" "FortWeb app/index.html"
require_file "${FORTWEB_SOURCE_DIR}/pyscript-ci.toml" "FortWeb pyscript-ci.toml"
require_dir "${FORTWEB_SOURCE_DIR}/vendor" "FortWeb vendor directory"
require_dir "${FORTWEB_SOURCE_DIR}/wheels" "FortWeb wheels directory"
require_file "${FORTWEB_MANIFEST_TOOL}" "FortWeb manifest tool"
require_file "${PAYLOAD_VALIDATOR}" "payload validator"
require_file "${BRIDGE_CONTRACT_SRC}" "generated bridge contract"

echo "[sync-payload] syncing shared payload into Android assets"
mkdir -p "${WRAPPER_PAYLOAD_DIR}"
rm -rf "${WRAPPER_PAYLOAD_DIR}"/*
mkdir -p "${WRAPPER_PAYLOAD_DIR}/fortweb"
cp -R "${FORTWEB_SOURCE_DIR}/app" "${WRAPPER_PAYLOAD_DIR}/fortweb/app"
cp -R "${FORTWEB_SOURCE_DIR}/vendor" "${WRAPPER_PAYLOAD_DIR}/fortweb/vendor"
cp -R "${FORTWEB_SOURCE_DIR}/wheels" "${WRAPPER_PAYLOAD_DIR}/fortweb/wheels"
cp "${FORTWEB_SOURCE_DIR}/pyscript-ci.toml" "${WRAPPER_PAYLOAD_DIR}/fortweb/pyscript-ci.toml"

cat > "${WRAPPER_PAYLOAD_DIR}/index.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>KERI Wallet</title>
  <script>
    window.location.replace('./fortweb/app/index.html');
  </script>
</head>
<body></body>
</html>
EOF

node "${FORTWEB_MANIFEST_TOOL}" \
  --payload-root "${WRAPPER_PAYLOAD_DIR}" \
  --fortweb-dir "${FORTWEB_SOURCE_DIR}" \
  --build-command './sync-payload.sh'

MANIFEST_PATH="${WRAPPER_PAYLOAD_DIR}/build-manifest.json" python3 - <<'PY'
import json
import os
from pathlib import Path

manifest_path = Path(os.environ["MANIFEST_PATH"])
manifest = json.loads(manifest_path.read_text())
expected_target = {
    "id": "android-asset-payload",
    "path": "app/src/main/assets/payload",
    "mutations": ["redirect_root_to_fortweb_app"],
}

sync_targets = manifest.setdefault("sync_targets", [])
for index, entry in enumerate(sync_targets):
    if entry.get("id") == expected_target["id"]:
        sync_targets[index] = expected_target
        break
else:
    sync_targets.append(expected_target)

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

node "${PAYLOAD_VALIDATOR}" \
  --payload-dir "${WRAPPER_PAYLOAD_DIR}" \
  --target android-asset-payload

mkdir -p "${BRIDGE_CONTRACT_DEST_DIR}"
cp "${BRIDGE_CONTRACT_SRC}" "${BRIDGE_CONTRACT_DEST}"

require_file "${WRAPPER_PAYLOAD_DIR}/index.html" "generated index.html"
require_file "${WRAPPER_PAYLOAD_DIR}/build-manifest.json" "generated build-manifest.json"
require_file "${BRIDGE_CONTRACT_DEST}" "synced BridgeContract.kt"

FILE_COUNT=$(find "${WRAPPER_PAYLOAD_DIR}" -type f | wc -l | tr -d ' ')
DIST_HASH=$(python3 -c 'import json; print(json.load(open("'"${WRAPPER_PAYLOAD_DIR}/build-manifest.json"'"))["dist_tree_sha256"])')

if [[ "${FETCH_MODE}" -eq 1 ]]; then
  SOURCE_LABEL="fetch:${FORTWEB_REMOTE}@${FORTWEB_REF}"
else
  SOURCE_LABEL="local:${FORTWEB_SOURCE_DIR}"
fi

echo "[sync-payload] ok: source=${SOURCE_LABEL} files=${FILE_COUNT} dist_tree_sha256=${DIST_HASH}"

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORT_IOS_DIR="${SCRIPT_DIR}/../Fort-ios"
WRAPPER_PAYLOAD_DIR="${SCRIPT_DIR}/app/src/main/assets/payload"
BRIDGE_CONTRACT_SRC="${FORT_IOS_DIR}/generated/BridgeContract.kt"
BRIDGE_CONTRACT_DEST_DIR="${SCRIPT_DIR}/app/src/main/java/org/kerifoundation/fort/bridge"
BRIDGE_CONTRACT_DEST="${BRIDGE_CONTRACT_DEST_DIR}/BridgeContract.kt"

if [[ ! -f "${FORT_IOS_DIR}/build-payload.sh" ]]; then
  echo "error: expected shared payload builder at ${FORT_IOS_DIR}/build-payload.sh" 1>&2
  echo "       Normal Android builds remain self-contained because app/src/main/assets/payload/ is committed here." 1>&2
  echo "       This script is only needed when refreshing the bundled shared payload from a workspace checkout." 1>&2
  exit 1
fi

source "${FORT_IOS_DIR}/build-payload.sh"

echo "[sync-payload] syncing shared payload into Android assets"
mkdir -p "${WRAPPER_PAYLOAD_DIR}"
rm -rf "${WRAPPER_PAYLOAD_DIR}"/*
cp -R "${PAYLOAD_DIST_DIR}"/. "${WRAPPER_PAYLOAD_DIR}/"

if [[ ! -f "${BRIDGE_CONTRACT_SRC}" ]]; then
  echo "error: expected generated bridge contract at ${BRIDGE_CONTRACT_SRC}" 1>&2
  exit 1
fi

mkdir -p "${BRIDGE_CONTRACT_DEST_DIR}"
cp "${BRIDGE_CONTRACT_SRC}" "${BRIDGE_CONTRACT_DEST}"

if [[ ! -f "${WRAPPER_PAYLOAD_DIR}/index.html" ]]; then
  echo "error: expected index.html missing after sync" 1>&2
  exit 1
fi

if [[ ! -f "${WRAPPER_PAYLOAD_DIR}/build-manifest.json" ]]; then
  echo "error: expected build-manifest.json missing after sync" 1>&2
  exit 1
fi

if [[ ! -f "${BRIDGE_CONTRACT_DEST}" ]]; then
  echo "error: expected BridgeContract.kt missing after sync" 1>&2
  exit 1
fi

FILE_COUNT=$(find "${WRAPPER_PAYLOAD_DIR}" -type f | wc -l | tr -d ' ')
DIST_HASH=$(python3 -c 'import json; print(json.load(open("'"${WRAPPER_PAYLOAD_DIR}/build-manifest.json"'"))["dist_tree_sha256"])')

echo "[sync-payload] ok: files=${FILE_COUNT} dist_tree_sha256=${DIST_HASH}"
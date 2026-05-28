#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
local_properties="$repo_root/local.properties"
default_sdk="$HOME/Library/Android/sdk"
print_exports_only=0

if [[ "${1:-}" == "--print-exports" ]]; then
    print_exports_only=1
elif [[ $# -gt 0 ]]; then
    echo "Unknown argument: $1" >&2
    echo "Usage: $0 [--print-exports]" >&2
    exit 64
fi

trim() {
    local value="$1"
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    printf '%s\n' "$value"
}

normalize_path() {
    local value="$1"
    if [[ -d "$value" ]]; then
        (
            cd "$value"
            pwd
        )
    else
        printf '%s\n' "$value"
    fi
}

read_local_properties_sdk() {
    if [[ ! -f "$local_properties" ]]; then
        return
    fi

    local line
    line="$(grep '^sdk\.dir=' "$local_properties" | tail -n 1 || true)"
    if [[ -z "$line" ]]; then
        return
    fi

    line="${line#sdk.dir=}"
    line="${line//\\:/:}"
    line="${line//\\=/=}"
    printf '%s\n' "$line"
}

add_candidate() {
    local source_name="$1"
    local sdk_path="$2"
    local existing

    sdk_path="$(trim "$sdk_path")"
    [[ -n "$sdk_path" ]] || return 0
    sdk_path="$(normalize_path "$sdk_path")"

    for existing in "${sdk_candidates[@]:-}"; do
        if [[ "$existing" == "$sdk_path" ]]; then
            return
        fi
    done

    sdk_candidates+=("$sdk_path")
    sdk_sources+=("$source_name")
}

join_by_comma() {
    local first=1
    local item

    for item in "$@"; do
        if [[ $first -eq 1 ]]; then
            printf '%s' "$item"
            first=0
        else
            printf ', %s' "$item"
        fi
    done
    printf '\n'
}

sdk_candidates=()
sdk_sources=()
local_properties_sdk="$(read_local_properties_sdk)"
android_home_value="${ANDROID_HOME:-}"
android_sdk_root_value="${ANDROID_SDK_ROOT:-}"
env_ambiguous=0

if [[ -n "$android_home_value" && -n "$android_sdk_root_value" ]]; then
    if [[ "$(normalize_path "$android_home_value")" != "$(normalize_path "$android_sdk_root_value")" ]]; then
        env_ambiguous=1
    fi
fi

add_candidate "local.properties sdk.dir" "$local_properties_sdk"
add_candidate "ANDROID_HOME" "$android_home_value"
add_candidate "ANDROID_SDK_ROOT" "$android_sdk_root_value"
add_candidate "default macOS SDK" "$default_sdk"

resolved_sdk=""
resolved_sdk_source=""
adb_from_sdk=""
emulator_from_sdk=""

for index in "${!sdk_candidates[@]}"; do
    candidate="${sdk_candidates[$index]}"
    if [[ -x "$candidate/platform-tools/adb" ]]; then
        resolved_sdk="$candidate"
        resolved_sdk_source="${sdk_sources[$index]}"
        adb_from_sdk="$candidate/platform-tools/adb"
        if [[ -x "$candidate/emulator/emulator" ]]; then
            emulator_from_sdk="$candidate/emulator/emulator"
        fi
        break
    fi
done

adb_in_path="$(command -v adb || true)"
emulator_in_path="$(command -v emulator || true)"
resolved_adb="$adb_from_sdk"
resolved_emulator="$emulator_from_sdk"

if [[ -z "$resolved_adb" && -n "$adb_in_path" ]]; then
    resolved_adb="$adb_in_path"
fi

if [[ -z "$resolved_emulator" && -n "$emulator_in_path" ]]; then
    resolved_emulator="$emulator_in_path"
fi

discovery_classification="ADB_NOT_FOUND"
if [[ $env_ambiguous -eq 1 ]]; then
    discovery_classification="ADB_ENV_AMBIGUOUS"
elif [[ -n "$adb_in_path" ]]; then
    discovery_classification="ADB_IN_PATH"
elif [[ -n "$adb_from_sdk" ]]; then
    discovery_classification="ADB_FOUND_BY_SDK_PATH"
fi

if [[ $print_exports_only -eq 1 ]]; then
    if [[ "$discovery_classification" == "ADB_ENV_AMBIGUOUS" ]]; then
        echo "ANDROID_HOME and ANDROID_SDK_ROOT point to different SDK roots" >&2
        exit 4
    fi
    if [[ -z "$resolved_sdk" || -z "$resolved_adb" ]]; then
        echo "Android SDK platform-tools/adb not found" >&2
        exit 2
    fi

    cat <<EOF
export ANDROID_HOME="$resolved_sdk"
export PATH="\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$PATH"
export ANDROID_SDK_ROOT="\$ANDROID_HOME"
EOF
    exit 0
fi

echo "DISCOVERY_CLASSIFICATION=$discovery_classification"
echo "LOCAL_PROPERTIES_SDK=${local_properties_sdk:-<unset>}"
echo "ANDROID_HOME=${android_home_value:-<unset>}"
echo "ANDROID_SDK_ROOT=${android_sdk_root_value:-<unset>}"
echo "ADB_IN_PATH=${adb_in_path:-<missing>}"
echo "EMULATOR_IN_PATH=${emulator_in_path:-<missing>}"
echo "RESOLVED_SDK=${resolved_sdk:-<missing>}"
echo "RESOLVED_SDK_SOURCE=${resolved_sdk_source:-<missing>}"
echo "RESOLVED_ADB=${resolved_adb:-<missing>}"
echo "RESOLVED_EMULATOR=${resolved_emulator:-<missing>}"

echo
echo "EXPORT_GUIDANCE"
if [[ -n "$resolved_sdk" ]]; then
    echo "export ANDROID_HOME=\"$resolved_sdk\""
    echo 'export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"'
    echo 'export ANDROID_SDK_ROOT="$ANDROID_HOME"'
else
    echo "Unable to suggest exports because no SDK root was resolved"
fi

if [[ "$discovery_classification" == "ADB_ENV_AMBIGUOUS" ]]; then
    echo
    echo "ANDROID_HOME and ANDROID_SDK_ROOT are both set but disagree. Keep them identical or unset ANDROID_SDK_ROOT." >&2
    exit 4
fi

if [[ -z "$resolved_adb" ]]; then
    echo
    echo "Could not find adb in PATH or under the repo-resolved Android SDK." >&2
    exit 2
fi

echo
echo "ADB_VERSION"
"$resolved_adb" version

if [[ -n "$resolved_emulator" ]]; then
    echo
    echo "EMULATOR_VERSION"
    "$resolved_emulator" -version
fi

"$resolved_adb" start-server >/dev/null

adb_devices_output="$("$resolved_adb" devices -l 2>&1)"

echo
echo "ADB_DEVICES"
printf '%s\n' "$adb_devices_output"

authorized_emulators=()
authorized_devices=()
unauthorized_targets=()
offline_targets=()

while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" == "List of devices attached" ]] && continue
    [[ "$line" == *"daemon started successfully"* ]] && continue
    [[ "$line" == *"daemon not running"* ]] && continue

    serial="${line%%[[:space:]]*}"
    if [[ "$line" == *" unauthorized"* ]]; then
        unauthorized_targets+=("$serial")
    elif [[ "$line" == *" offline"* ]]; then
        offline_targets+=("$serial")
    elif [[ "$line" == *$'\tdevice'* || "$line" == *" device "* || "$line" == *" device" ]]; then
        if [[ "$serial" == emulator-* ]]; then
            authorized_emulators+=("$serial")
        else
            authorized_devices+=("$serial")
        fi
    fi
done <<< "$adb_devices_output"

runtime_classification="ANDROID_RUNTIME_BLOCKED_NO_DEVICE"
exit_code=6

if [[ ${#authorized_emulators[@]} -gt 0 ]]; then
    runtime_classification="ANDROID_RUNTIME_READY_EMULATOR_CONNECTED"
    exit_code=0
elif [[ ${#authorized_devices[@]} -gt 0 ]]; then
    runtime_classification="ANDROID_RUNTIME_READY_DEVICE_CONNECTED"
    exit_code=0
elif [[ ${#unauthorized_targets[@]} -gt 0 ]]; then
    runtime_classification="ANDROID_RUNTIME_BLOCKED_UNAUTHORIZED_DEVICE"
    exit_code=5
fi

echo
echo "RUNTIME_CLASSIFICATION=$runtime_classification"

if [[ ${#authorized_emulators[@]} -gt 0 ]]; then
    echo "AUTHORIZED_EMULATORS=$(join_by_comma "${authorized_emulators[@]}")"
fi

if [[ ${#authorized_devices[@]} -gt 0 ]]; then
    echo "AUTHORIZED_DEVICES=$(join_by_comma "${authorized_devices[@]}")"
fi

if [[ ${#unauthorized_targets[@]} -gt 0 ]]; then
    echo "UNAUTHORIZED_TARGETS=$(join_by_comma "${unauthorized_targets[@]}")"
fi

if [[ ${#offline_targets[@]} -gt 0 ]]; then
    echo "OFFLINE_TARGETS=$(join_by_comma "${offline_targets[@]}")"
fi

if [[ $exit_code -ne 0 && -n "$resolved_emulator" ]]; then
    echo
    echo "AVAILABLE_AVDS"
    "$resolved_emulator" -list-avds || true
fi

exit $exit_code
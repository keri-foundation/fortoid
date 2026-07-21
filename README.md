# Fort Android

KERI Fort mobile application shell for Android.

## Architecture

Fort Android is a hardened WebView shell that hosts the shared [FortWeb](https://github.com/keri-foundation/fortweb) runtime. FortWeb owns the product UI, routing, Python/Pyodide backend, and bridge protocol. Android owns the native wrapper, WebView security policy, and platform lifecycle.

## Prerequisites

- Android Studio (latest stable)
- JDK 17+
- Android SDK 36 with build tools
- Node.js 20+
- A sibling [FortWeb](https://github.com/keri-foundation/fortweb) checkout

## Quick Start

```bash
# Sync the canonical FortWeb runtime into the Android payload
./sync-payload.sh --fortweb-dir ../fortweb

# Build and install on emulator
./gradlew :app:assembleDebug
```

## Payload Synchronization

Android consumes the canonical `FortWeb/dist/runtime` artifact.

### Local mode

```bash
./sync-payload.sh --fortweb-dir ../fortweb
```

### Fetch mode

```bash
./sync-payload.sh --fetch --ref main
./sync-payload.sh --fetch --ref <commit-sha>
```

Fetch mode always requires `--ref`.

## Build

```bash
./gradlew verifyPreparedPayload
./gradlew :app:lintDebug
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

## Generated Payload Policy

`app/src/main/assets/payload/` is generated and gitignored.

## Deferred Work

- Bridge contract generation
- Runtime-origin contract injection
- WebView host modernization (PR #22 reference)
- Emulator acceptance testing

## Relationship to PR #22

PR #22 contains substantial wrapper work but predates the canonical `dist/runtime` pipeline. It serves as an implementation reference.

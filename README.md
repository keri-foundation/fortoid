# Fort Android

KERI Fort mobile application shell for Android.

## Architecture

Fort Android is a hardened WebView shell that hosts the shared [FortWeb](https://github.com/keri-foundation/fortweb) runtime. FortWeb owns the product UI, routing, Python/Pyodide backend, and bridge protocol. Android owns the native wrapper, WebView security policy, and platform lifecycle.

## Prerequisites

- Android Studio (latest stable)
- JDK 17+
- Android SDK 36 with build tools
- Node.js 20+
- Python 3.12+ (used by the canonical FortWeb producer build)
- Optional: a local [FortWeb](https://github.com/keri-foundation/fortweb) checkout, only for `--fortweb-dir`

## Quick Start

```bash
# Stage the canonical FortWeb runtime into the Android payload
./sync-payload.sh --fetch --locked

# Build and install on emulator
./gradlew :app:assembleDebug
```

## Payload Synchronization

Android consumes one canonical FortWeb runtime package. The producer revision is
never a parameter: `config/fortweb-runtime.json` is the sole authority, and every
mode is bound to it.

### Package mode (primary)

Stage an already-produced package. No checkout, no build, no network.

```bash
./sync-payload.sh --package /path/to/fortweb-runtime.zip
```

### Locked fetch mode

Fetch the locked revision, build the canonical package, then stage it.

```bash
./sync-payload.sh --fetch --locked
```

### Locked local checkout mode

Build from an existing checkout, which must already be at the locked revision.

```bash
./sync-payload.sh --fortweb-dir ../fortweb
```

### Inspect without running

`--print-plan` prints the exact sequence, including the canonical producer's
steps, without executing anything.

```bash
./sync-payload.sh --fetch --locked --print-plan
```

### Lock authority

- `config/fortweb-runtime.json` pins the producer repository and commit.
- A local checkout must equal the locked commit, or the sync is refused.
- The imported package manifest's `fortweb_commit_sha` must equal the lock, or the
  import is refused before anything is staged.
- Mutable refs are not supported. `--ref` is rejected.

There is no published Fortoid runtime release yet, so a package currently comes
from a canonical local build (`--fetch --locked` or `--fortweb-dir`) or from an
appropriate CI artifact. Do not assume a downloadable release exists.

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

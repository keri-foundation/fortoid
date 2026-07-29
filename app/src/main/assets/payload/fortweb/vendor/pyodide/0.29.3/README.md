## Pyodide 0.29.3

This directory pins the Fortweb browser harness to a local Pyodide runtime.

Core runtime files and Pyodide-managed package artifacts in this directory came
from the official GitHub release asset:

- `https://github.com/pyodide/pyodide/releases/download/0.29.3/pyodide-0.29.3.tar.bz2`

Fortweb-specific extra pure-Python wheels live in `vendor/pyodide/0.29.3/wheels/`.
They are served locally and preloaded by `python/run_keripy_wasm_ci.py` with
local `pyodide_js.loadPackage(...)` URLs so the harness boot path does not need
remote package resolution.

When bumping this runtime later:

1. Download the new `pyodide-<version>.tar.bz2` GitHub release asset and verify its published SHA-256 digest before copying files into this directory.
2. Refresh the exact Pyodide package filenames served from this directory so they still match `pyodide-lock.json`.
3. Refresh `vendor/pyodide/<version>/wheels/` for any extra non-Pyodide wheels Fortweb still needs.
4. Update `pyscript-ci.toml` if the interpreter path changes, and update the preload lists in `python/run_keripy_wasm_ci.py` if package names or wheel filenames change.
5. Re-run `npm run test:browser -- playwright/keripy-wasm.spec.ts` and confirm the local-runtime request test stays green.

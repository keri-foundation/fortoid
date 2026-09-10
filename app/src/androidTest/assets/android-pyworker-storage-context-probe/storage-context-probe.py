"""Android PyWorker storage-context diagnostic (test-only).

Runs inside a real PyScript PyWorker using the canonical vendored PyScript
2025.11.2 runtime. Captures a bounded structured observation of the worker's
Python/PyScript/polyscript/IndexedDB/config environment to locate where the
Android-hosted worker diverges from the browser control.

This is a diagnostic. It does NOT modify producer bytes and does NOT attempt a
fix. Absence of storage is a valid measured result.
"""

from __future__ import annotations

import asyncio
import sys
import uuid

__export__ = ["diagnostic"]


def _short_repr(value, limit: int = 400):
    try:
        return repr(value)[:limit]
    except Exception as exc:  # noqa: BLE001
        return "<repr failed: %s>" % (exc,)


def _short_dir(obj, limit: int = 60):
    try:
        return [n for n in dir(obj) if not n.startswith("__")][:limit]
    except Exception as exc:  # noqa: BLE001
        return ["<dir failed: %s>" % (exc,)]


def _config_summary(config):
    """Bounded summary of pyscript.config; never dumps large/sensitive values."""
    if config is None:
        return {"present": False}
    try:
        cfg = dict(config)
    except Exception as exc:  # noqa: BLE001
        return {"present": True, "to_dict_error": "%s: %s" % (type(exc).__name__, exc)}
    keys = sorted(str(k) for k in cfg.keys())[:60]
    fro = cfg.get("fort_runtime_origin")
    summary = {"present": True, "keys": keys, "has_fort_runtime_origin": "fort_runtime_origin" in cfg}
    if isinstance(fro, dict):
        summary["fort_runtime_origin_summary"] = {
            "schema": fro.get("schema"),
            "platform": fro.get("platform"),
            "mode": fro.get("mode"),
            "version": fro.get("version"),
        }
    else:
        summary["fort_runtime_origin_summary"] = None
    return summary


def _probe_pyscript():
    out = {}
    try:
        import pyscript as _p
        out["import_success"] = True
        out["type"] = str(type(_p))
        out["file"] = repr(getattr(_p, "__file__", None))
        out["has_storage"] = bool(hasattr(_p, "storage"))
        out["storage_repr"] = _short_repr(getattr(_p, "storage", None))
        out["config"] = _config_summary(getattr(_p, "config", None))
    except Exception as exc:  # noqa: BLE001
        out["import_success"] = False
        out["import_error"] = "%s: %s" % (type(exc).__name__, exc)

    try:
        from pyscript import storage as _s
        out["storage_import_success"] = True
        out["storage_import_repr"] = _short_repr(_s)
    except Exception as exc:  # noqa: BLE001
        out["storage_import_success"] = False
        out["storage_import_error_class"] = type(exc).__name__
        out["storage_import_error_message"] = str(exc)
    return out


def _probe_polyscript():
    out = {}
    try:
        import polyscript as _poly
        out["import_success"] = True
        out["type"] = str(type(_poly))
        out["has_storage"] = bool(hasattr(_poly, "storage"))
        out["storage_repr"] = _short_repr(getattr(_poly, "storage", None))
        out["has_idbmap"] = bool(hasattr(_poly, "IDBMap"))
        out["has_idbmapsync"] = bool(hasattr(_poly, "IDBMapSync"))
        out["short_dir"] = _short_dir(_poly)
    except Exception as exc:  # noqa: BLE001
        out["import_success"] = False
        out["import_error"] = "%s: %s" % (type(exc).__name__, exc)

    try:
        from polyscript import storage as _ps
        out["storage_import_success"] = True
        out["storage_import_repr"] = _short_repr(_ps)
    except Exception as exc:  # noqa: BLE001
        out["storage_import_success"] = False
        out["storage_import_error_class"] = type(exc).__name__
        out["storage_import_error_message"] = str(exc)
    return out


def _probe_indexeddb():
    out = {}
    try:
        import js
        idb = getattr(js, "indexedDB", None)
        out["present"] = idb is not None
        out["open_callable"] = bool(callable(getattr(idb, "open", None))) if idb is not None else False
    except Exception as exc:  # noqa: BLE001
        out["present"] = False
        out["error_class"] = type(exc).__name__
        out["error_message"] = str(exc)
    return out


# Mirrors producer wallet-worker.py (e079701) package loading so that
# `import keri.db.webdbing` sees the same dependency surface in the diagnostic
# worker as in production.
_PROBE_PYODIDE_PACKAGE_NAMES = [
    "cryptography",
    "jsonschema",
    "multidict",
    "packaging",
    "pyyaml",
    "setuptools",
    "sortedcontainers",
    "typing-extensions",
    "wcwidth",
]
_PROBE_LOCAL_WHEEL_PATHS = [
    "/vendor/pyodide/0.29.3/wheels/apispec-6.9.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/cbor2-5.8.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/hjson-3.1.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/http_sfv-0.9.9-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/mnemonic-0.21-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/multicommand-1.0.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/ordered_set-4.1.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/prettytable-3.17.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/pyasn1-0.6.2-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/pyasn1_alt_modules-0.4.7-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/pypng-0.20220715.0-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/qrcode-7.4.2-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/semver-3.0.4-py3-none-any.whl",
    "/vendor/pyodide/0.29.3/wheels/wheel-0.45.1-py3-none-any.whl",
    "/wheels/blake3-1.0.8-cp313-cp313-pyodide_2025_0_wasm32.whl",
    "/wheels/msgpack-1.1.2-py3-none-any.whl",
    "/wheels/pychloride-0.7.18.2-py3-none-any.whl",
    "/wheels/hio_web-0.7.20-py3-none-any.whl",
    "/wheels/keri_web-2.0.0.dev6-py3-none-any.whl",
]
_PROBE_ORIGIN = "https://appassets.androidplatform.net"


async def _load_package_batch(specs):
    if not specs:
        return

    from pyodide_js import loadPackage

    pending = loadPackage(specs)
    if asyncio.iscoroutine(pending):
        await pending


async def _do_load_runtime_packages():
    await _load_package_batch(_PROBE_PYODIDE_PACKAGE_NAMES)
    await _load_package_batch([f"{_PROBE_ORIGIN}{path}" for path in _PROBE_LOCAL_WHEEL_PATHS])


def _probe_keri_webdbing():
    """Load the canonical KERI wheel set and import webdbing, mirroring the
    producer's package loading. Reports whether webdbing.storage resolved to a
    callable or to None (the production failure mode)."""
    out = {}

    async def _load_and_import():
        try:
            await _do_load_runtime_packages()
            out["package_load_success"] = True
        except Exception as exc:  # noqa: BLE001
            out["package_load_success"] = False
            out["package_load_error"] = "%s: %s" % (type(exc).__name__, exc)
            return
        try:
            import keri.db.webdbing as _wd
            out["import_success"] = True
            out["webdbing_storage_is_none"] = getattr(_wd, "storage", "MISSING") is None
            out["webdbing_storage_repr"] = _short_repr(getattr(_wd, "storage", "MISSING"))
        except Exception as exc:  # noqa: BLE001
            out["import_success"] = False
            out["import_error"] = "%s: %s" % (type(exc).__name__, exc)

        return out

    return _load_and_import


async def _minimal_storage_op():
    """Only run when `from pyscript import storage` succeeded. Uses a unique
    test-only database name; never touches the production vault registry."""
    out = {}
    try:
        from pyscript import storage as storage_fn

        name = "fortoid-pyworker-storage-probe-%s" % uuid.uuid4().hex[:8]
        handle = await storage_fn(name)
        key = "probe-key"
        value = "probe-value-123"
        handle[key] = value
        await handle.sync()
        out["success"] = True
        out["value_roundtrip"] = handle.get(key) == value
        out["handle_type"] = str(type(handle))
    except Exception as exc:  # noqa: BLE001
        out["success"] = False
        out["error_class"] = type(exc).__name__
        out["error_message"] = str(exc)
    return out


async def diagnostic():
    result = {"python_version": sys.version.split()[0]}

    pyscript_state = _probe_pyscript()
    result["pyscript"] = pyscript_state

    polyscript_state = _probe_polyscript()
    result["polyscript"] = polyscript_state

    result["indexeddb"] = _probe_indexeddb()

    result["before_keri_pyscript_has_storage"] = pyscript_state.get("has_storage")
    result["before_keri_polyscript_has_storage"] = polyscript_state.get("has_storage")

    keri_probe = _probe_keri_webdbing()
    result["keri"] = await keri_probe()

    result["after_keri_pyscript_has_storage"] = _probe_pyscript().get("has_storage")
    result["after_keri_polyscript_has_storage"] = _probe_polyscript().get("has_storage")

    if pyscript_state.get("storage_import_success"):
        result["minimal_storage"] = await _minimal_storage_op()
    else:
        result["minimal_storage"] = {"skipped": True, "reason": "pyscript.storage import failed"}

    return result

#!/usr/bin/env node

/**
 * Validate runtime-requirements compatibility against platform configuration.
 *
 * Maps FortWeb-owned runtime requirements (contracts/runtime-requirements.json)
 * to Fortoid-owned mechanism-first platform config (runtime-platform-config.json).
 *
 * Every capability and forbidden behavior must have exactly one registered
 * predicate. Unknown identifiers fail closed.
 *
 * Usage:
 *   node tools/validate-runtime-requirements-compatibility.mjs [payload-dir]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PAYLOAD_DIR = path.join(REPO_ROOT, 'app/src/main/assets/payload');
const CONFIG_PATH = path.join(REPO_ROOT, 'runtime-platform-config.json');
const MANIFEST_FILENAME = 'manifest.json';
const EXPECTED_RR_PATH = 'contracts/runtime-requirements.json';
const EXPECTED_SCHEMA = 'fort.runtime-requirements.v1';
const EXPECTED_VERSION = 1;
const EXPECTED_PRODUCER = 'fortweb';
const EXPECTED_PROFILE = 'offline-runtime';
const CONFIG_SCHEMA = 'fort.runtime-platform-config.v1';

// Canonical capability set — derived from the published v1 contract.
// Every capability must be present and registered.
const CANONICAL_CAPABILITIES = new Set([
  'stable_origin_across_launches',
  'persistent_storage_partition',
  'secure_context',
  'remote_network_prohibition',
  'bundled_assets_only',
  'worker_availability',
  'main_frame_provenance',
  'origin_provenance',
  'deterministic_entrypoint',
  'no_fallback_shell_substitution',
]);

// Canonical forbidden-behavior set — derived from the published v1 contract.
const CANONICAL_FORBIDDEN_BEHAVIORS = new Set([
  'network_fetch',
  'service_worker_registration',
  'general_purpose_browsing',
  'localhost_or_loopback_origin',
  'http_fallback',
]);

class CompatibilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CompatibilityError'; }
}

// ── Capability predicates ───────────────────────────────────────────────────
// Each predicate receives (requirements, config) and returns:
//   { compatible: true } or { compatible: false, reason: string, evidence: string }

const CAPABILITY_PREDICATES = {

  stable_origin_across_launches(rr, cfg) {
    const origin = cfg?.origin;
    if (!origin || origin.stability !== 'fixed-across-launches') {
      return { compatible: false, reason: 'origin stability not declared as fixed-across-launches', evidence: 'config' };
    }
    if (origin.host !== 'appassets.androidplatform.net' || origin.scheme !== 'https') {
      return { compatible: false, reason: 'origin must be https://appassets.androidplatform.net', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: hardcoded TRUSTED_HOST, TRUSTED_ORIGIN_RULE
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  persistent_storage_partition(rr, cfg) {
    const storage = cfg?.storage;
    if (!storage || storage.mechanism !== 'webview-persistent') {
      return { compatible: false, reason: 'storage mechanism not declared as webview-persistent', evidence: 'config' };
    }
    if (storage.partition !== 'fixed-path-prefix') {
      return { compatible: false, reason: 'storage partition not declared as fixed-path-prefix', evidence: 'config' };
    }
    // HOSTED PROVEN: PersistenceWriteTest + PersistenceReadTest prove
    // IndexedDB data survives process termination on API 36.
    return { compatible: true, evidence: 'HOSTED PROVEN' };
  },

  secure_context(rr, cfg) {
    const sc = cfg?.security_context;
    if (!sc || sc.mechanism !== 'https-tls-like') {
      return { compatible: false, reason: 'security context not declared as https-tls-like', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: usesCleartextTraffic=false, https origin
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  remote_network_prohibition(rr, cfg) {
    const net = cfg?.network;
    if (!net || net.policy !== 'deny-all') {
      return { compatible: false, reason: 'network policy not declared as deny-all', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: WebRequestPolicy blocks non-trusted subresources
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  bundled_assets_only(rr, cfg) {
    const assets = cfg?.assets;
    if (!assets || assets.source !== 'application-bundle') {
      return { compatible: false, reason: 'asset source not declared as application-bundle', evidence: 'config' };
    }
    if (assets.delivery !== 'webview-asset-loader') {
      return { compatible: false, reason: 'asset delivery not declared as webview-asset-loader', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: WebViewAssetLoader with PayloadRootPathHandler
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  worker_availability(rr, cfg) {
    const workers = cfg?.workers;
    if (!workers || workers.available !== true) {
      return { compatible: false, reason: 'workers.available must be true', evidence: 'config' };
    }
    // HOSTED PROVEN: WorkerRuntimeProofTest + PyodideWorkerRuntimeProofTest
    // prove Web Workers function for Pyodide workloads on API 36.
    return { compatible: true, evidence: 'HOSTED PROVEN' };
  },

  main_frame_provenance(rr, cfg) {
    const bridge = cfg?.bridge;
    if (!bridge || bridge.provenance !== 'main-frame-only') {
      return { compatible: false, reason: 'bridge provenance not declared as main-frame-only', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: WebMessageListener checks isMainFrame
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  origin_provenance(rr, cfg) {
    const bridge = cfg?.bridge;
    if (!bridge || bridge.origin_validation !== 'exact-scheme-host-match') {
      return { compatible: false, reason: 'bridge origin validation not declared as exact-scheme-host-match', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: isTrustedBridgeOrigin checks exact scheme+host
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  deterministic_entrypoint(rr, cfg) {
    const ep = cfg?.entrypoint;
    if (!ep || ep.source !== 'deterministic-constant') {
      return { compatible: false, reason: 'entrypoint source not declared as deterministic-constant', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: PAYLOAD_URL constant
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  no_fallback_shell_substitution(rr, cfg) {
    const ep = cfg?.entrypoint;
    if (ep?.fallback === 'payload-missing-placeholder') {
      return { compatible: false, reason: 'payload-missing-placeholder fallback contradicts no_fallback_shell_substitution', evidence: 'CONTRADICTED' };
    }
    if (ep?.fallback === 'none') {
      // Missing payload files return null; WebViewAssetLoader produces a
      // not-found response. No shell substitution occurs.
      return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
    }
    return { compatible: false, reason: `unknown fallback mechanism: "${ep?.fallback || '(missing)'}"`, evidence: 'FAIL-CLOSED' };
  },
};

// ── Forbidden-behavior predicates ───────────────────────────────────────────

const FORBIDDEN_PREDICATES = {

  network_fetch(rr, cfg) {
    const net = cfg?.network;
    if (net?.policy === 'deny-all') {
      return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
    }
    return { compatible: false, reason: 'network policy must be deny-all to prohibit network_fetch', evidence: 'config' };
  },

  service_worker_registration(rr, cfg) {
    // The runtime contract forbids registration. Android WebView DOES expose
    // Service Worker APIs (ServiceWorkerController since API 24), so the
    // platform must declare an explicit Android-owned prohibition mechanism.
    const workers = cfg?.workers;
    if (!workers || workers.service_worker_registration !== 'prohibited-by-host') {
      return { compatible: false, reason: 'workers.service_worker_registration must be "prohibited-by-host"', evidence: 'config' };
    }
    // STATICALLY-VERIFIED: an Android-owned document-start guard rejects
    // navigator.serviceWorker.register() before producer JS executes, with
    // native ServiceWorkerWebSettingsCompat defense-in-depth. Behavioral
    // hosted proof is a separate acceptance gate.
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  general_purpose_browsing(rr, cfg) {
    // External URLs are opened via Intent, not in the WebView.
    return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
  },

  localhost_or_loopback_origin(rr, cfg) {
    const origin = cfg?.origin;
    if (origin?.host === 'appassets.androidplatform.net' && origin?.scheme === 'https') {
      return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
    }
    return { compatible: false, reason: 'origin must be https://appassets.androidplatform.net', evidence: 'config' };
  },

  http_fallback(rr, cfg) {
    const origin = cfg?.origin;
    if (origin?.scheme === 'https') {
      return { compatible: true, evidence: 'STATICALLY-VERIFIED' };
    }
    return { compatible: false, reason: 'origin scheme must be https', evidence: 'config' };
  },
};

// ── Validation ──────────────────────────────────────────────────────────────

export async function validateCompatibility(payloadDir = DEFAULT_PAYLOAD_DIR, configPath = CONFIG_PATH) {
  const errors = [];

  // 1. Read manifest
  const mfPath = path.join(payloadDir, MANIFEST_FILENAME);
  if (!existsSync(mfPath)) return [{ type: 'error', message: `manifest.json not found at ${mfPath}` }];

  let manifest;
  try {
    const mfBytes = await readFile(mfPath);
    const mfText = new TextDecoder('utf-8', { fatal: true }).decode(mfBytes);
    manifest = JSON.parse(mfText);
  } catch (e) { return [{ type: 'error', message: `manifest.json: ${e.message}` }]; }

  // 2. Discover requirements path
  const rrRel = manifest?.contracts?.runtime_requirements?.path;
  if (!rrRel) return [{ type: 'error', message: 'manifest.contracts.runtime_requirements.path: missing' }];
  if (rrRel !== EXPECTED_RR_PATH) return [{ type: 'error', message: `unexpected requirements path: "${rrRel}" (expected "${EXPECTED_RR_PATH}")` }];

  // 3. Read requirements
  const rrPath = path.join(payloadDir, rrRel);
  if (!existsSync(rrPath)) return [{ type: 'error', message: `requirements file not found: ${rrRel}` }];

  let rr;
  try {
    const rrBytes = await readFile(rrPath);
    const rrText = new TextDecoder('utf-8', { fatal: true }).decode(rrBytes);
    if (rrText.includes('\uFFFD')) return [{ type: 'error', message: 'runtime-requirements.json: contains U+FFFD' }];
    rr = JSON.parse(rrText);
  } catch (e) { return [{ type: 'error', message: `runtime-requirements.json: ${e.message}` }]; }

  if (!rr.schema || rr.schema !== EXPECTED_SCHEMA) {
    errors.push({ type: 'error', message: `unsupported requirements schema: "${rr.schema || '(missing)'}"` });
  }
  if (rr.version !== EXPECTED_VERSION) {
    errors.push({ type: 'error', message: `unsupported requirements version: ${rr.version} (expected ${EXPECTED_VERSION})` });
  }
  if (!rr.producer || rr.producer !== EXPECTED_PRODUCER) {
    errors.push({ type: 'error', message: `unexpected producer: "${rr.producer || '(missing)'}"` });
  }
  if (!rr.payload_profile || rr.payload_profile !== EXPECTED_PROFILE) {
    errors.push({ type: 'error', message: `unsupported payload profile: "${rr.payload_profile || '(missing)'}"` });
  }
  if (errors.length) return errors;

  // 4. Read platform config
  if (!existsSync(configPath)) return [{ type: 'error', message: `platform config not found at ${configPath}` }];

  let config;
  try {
    const cfgBytes = await readFile(configPath);
    const cfgText = new TextDecoder('utf-8', { fatal: true }).decode(cfgBytes);
    if (cfgText.includes('\uFFFD')) return [{ type: 'error', message: 'runtime-platform-config.json: contains U+FFFD' }];
    config = JSON.parse(cfgText);
  } catch (e) { return [{ type: 'error', message: `runtime-platform-config.json: ${e.message}` }]; }

  if (!config.schema || config.schema !== CONFIG_SCHEMA) {
    errors.push({ type: 'error', message: `unsupported config schema: "${config.schema || '(missing)'}"` });
  }
  if (!config.platform || config.platform !== 'android-webview') {
    errors.push({ type: 'error', message: `unexpected platform: "${config.platform || '(missing)'}"` });
  }
  if (errors.length) return errors;

  // 5. Check requirements-compatibility declaration
  const rc = config.requirements_compatibility;
  if (!rc) {
    errors.push({ type: 'error', message: 'requirements_compatibility: missing' });
    return errors;
  }
  if (!rc.supported_schemas?.includes(EXPECTED_SCHEMA)) {
    errors.push({ type: 'error', message: `requirements_compatibility.supported_schemas does not include "${EXPECTED_SCHEMA}"` });
  }
  if (!rc.supported_profiles?.includes(EXPECTED_PROFILE)) {
    errors.push({ type: 'error', message: `requirements_compatibility.supported_profiles does not include "${EXPECTED_PROFILE}"` });
  }

  // 6. Evaluate capability predicates
  const capabilities = rr.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    return [{ type: 'error', message: 'runtime-requirements.json: capabilities missing or not an object' }];
  }

  const capResults = [];
  const registeredCaps = new Set(Object.keys(CAPABILITY_PREDICATES));
  const declaredCaps = new Set(Object.keys(capabilities));

  // Missing canonical capabilities (fail closed)
  for (const key of CANONICAL_CAPABILITIES) {
    if (!declaredCaps.has(key)) {
      capResults.push({ capability: key, compatible: false, reason: `missing required capability from producer vocabulary`, evidence: 'FAIL-CLOSED' });
    }
  }

  // Unknown capabilities (not in canonical set)
  for (const key of declaredCaps) {
    if (!CANONICAL_CAPABILITIES.has(key)) {
      capResults.push({ capability: key, compatible: false, reason: `unknown capability — not in canonical v1 vocabulary`, evidence: 'FAIL-CLOSED' });
      continue;
    }
    if (!registeredCaps.has(key)) {
      capResults.push({ capability: key, compatible: false, reason: `unknown capability — no predicate registered`, evidence: 'FAIL-CLOSED' });
      continue;
    }
    // Malformed capability entry
    const cap = capabilities[key];
    if (!cap || typeof cap !== 'object' || cap.required !== true) {
      capResults.push({ capability: key, compatible: false, reason: `malformed capability — required must be true`, evidence: 'FAIL-CLOSED' });
      continue;
    }
    let result;
    try {
      result = CAPABILITY_PREDICATES[key](rr, config);
    } catch (e) {
      result = { compatible: false, reason: `predicate error: ${e.message}`, evidence: 'ERROR' };
    }
    capResults.push({ capability: key, ...result });
  }

  // 7. Evaluate forbidden-behavior predicates
  const forbidden = rr.forbidden_behaviors;
  if (!Array.isArray(forbidden)) {
    return [{ type: 'error', message: 'runtime-requirements.json: forbidden_behaviors missing or not an array' }];
  }

  // Duplicate detection
  const fbSeen = new Set();
  const fbDups = [];
  for (const fb of forbidden) {
    if (fbSeen.has(fb)) fbDups.push(fb);
    fbSeen.add(fb);
  }
  if (fbDups.length) {
    return [{ type: 'error', message: `forbidden_behaviors contains duplicates: ${fbDups.join(', ')}` }];
  }

  const fbResults = [];
  const registeredFB = new Set(Object.keys(FORBIDDEN_PREDICATES));
  const declaredFB = new Set(forbidden);

  // Missing canonical forbidden behaviors
  for (const fb of CANONICAL_FORBIDDEN_BEHAVIORS) {
    if (!declaredFB.has(fb)) {
      fbResults.push({ forbidden_behavior: fb, compatible: false, reason: `missing required forbidden behavior from producer vocabulary`, evidence: 'FAIL-CLOSED' });
    }
  }

  for (const fb of forbidden) {
    if (!CANONICAL_FORBIDDEN_BEHAVIORS.has(fb)) {
      fbResults.push({ forbidden_behavior: fb, compatible: false, reason: `unknown forbidden behavior — not in canonical v1 vocabulary`, evidence: 'FAIL-CLOSED' });
      continue;
    }
    if (!registeredFB.has(fb)) {
      fbResults.push({ forbidden_behavior: fb, compatible: false, reason: `unknown forbidden behavior — no predicate registered`, evidence: 'FAIL-CLOSED' });
      continue;
    }
    let result;
    try {
      result = FORBIDDEN_PREDICATES[fb](rr, config);
    } catch (e) {
      result = { compatible: false, reason: `predicate error: ${e.message}`, evidence: 'ERROR' };
    }
    fbResults.push({ forbidden_behavior: fb, ...result });
  }

  // 8. Build result
  const allCompatible = errors.length === 0
    && capResults.every(r => r.compatible)
    && fbResults.every(r => r.compatible);

  return {
    compatible: allCompatible,
    errors,
    capabilities: capResults,
    forbidden_behaviors: fbResults,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const payloadDir = process.argv[2] || DEFAULT_PAYLOAD_DIR;
  const result = await validateCompatibility(payloadDir);

  if (result.errors?.length) {
    for (const e of result.errors) console.error(`[compat] ${e.message}`);
  }
  if (result.capabilities) {
    for (const c of result.capabilities) {
      const status = c.compatible ? 'SATISFIED' : 'NOT-SATISFIED';
      console.error(`[compat] capability ${c.capability}: ${status} (${c.evidence || 'N/A'})${c.compatible ? '' : ` — ${c.reason}`}`);
    }
  }
  if (result.forbidden_behaviors) {
    for (const f of result.forbidden_behaviors) {
      const status = f.compatible ? 'SATISFIED' : 'NOT-SATISFIED';
      console.error(`[compat] forbidden ${f.forbidden_behavior}: ${status} (${f.evidence || 'N/A'})${f.compatible ? '' : ` — ${f.reason}`}`);
    }
  }

  if (!result.compatible) {
    console.error('[compat] RESULT: INCOMPATIBLE');
    process.exit(1);
  }
  console.error('[compat] RESULT: COMPATIBLE');
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main();
}

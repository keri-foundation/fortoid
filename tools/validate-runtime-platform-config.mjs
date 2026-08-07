#!/usr/bin/env node
// ── validate-runtime-platform-config.mjs ─────────────────────────────────────
// Strict structural validator for fort.runtime-platform-config.v1.
// Android-owned — validates mechanism-first platform declarations.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, '..', 'runtime-platform-config.json');

// ── Schema definition ────────────────────────────────────────────────────────

const VALID_SCHEMA = 'fort.runtime-platform-config.v1';
const VALID_VERSION = 1;
const VALID_PLATFORMS = ['ios-wkwebview', 'android-webview'];

const FIELD_SCHEMA = {
  schema:     { type: 'string', required: true,  valid: VALID_SCHEMA },
  version:    { type: 'number', required: true,  valid: VALID_VERSION },
  platform:   { type: 'string', required: true,  valid: VALID_PLATFORMS },
  requirements_compatibility: { type: 'object', required: true },
  origin:             { type: 'object', required: true },
  network:            { type: 'object', required: true },
  assets:             { type: 'object', required: true },
  workers:            { type: 'object', required: true },
  storage:            { type: 'object', required: true },
  security_context:   { type: 'object', required: true },
  bridge:             { type: 'object', required: true },
  entrypoint:         { type: 'object', required: true },
};

const SUPPORTED_SCHEMAS = ['fort.runtime-requirements.v1'];
const SUPPORTED_PROFILES = ['offline-runtime'];

const ORIGIN_STABILITIES = ['fixed-across-launches'];
const NETWORK_POLICIES = ['deny-all'];
const ASSET_SOURCES = ['application-bundle'];
const ASSET_DELIVERIES = ['webview-asset-loader', 'custom-scheme-handler'];
const WORKER_FRAMEWORKS = ['webview-javascript', 'wkwebview-javascript'];
const STORAGE_MECHANISMS = ['webview-persistent', 'webkit-persistent'];
const STORAGE_PARTITIONS = ['fixed-path-prefix', 'fixed-namespace'];
const SECURITY_MECHANISMS = ['https-tls-like', 'custom-scheme-tls-like'];
const BRIDGE_PROVENANCES = ['main-frame-only'];
const BRIDGE_ORIGIN_VALIDATIONS = ['exact-scheme-host-match'];
const ENTRYPOINT_SOURCES = ['manifest-declared', 'deterministic-constant'];
const ENTRYPOINT_FALLBACKS = ['none'];

function checkType(value, expected, label) {
  const actual = typeof value;
  if (actual !== expected) {
    return `${label}: expected ${expected}, got ${actual}`;
  }
  return null;
}

function checkRequired(obj, field, def) {
  if (!(field in obj)) {
    return `missing required field: ${field}`;
  }
  const err = checkType(obj[field], def.type, field);
  if (err) return err;
  if (def.valid !== undefined) {
    const valid = Array.isArray(def.valid) ? def.valid : [def.valid];
    if (!valid.includes(obj[field])) {
      return `${field}: invalid value "${obj[field]}", expected one of: ${valid.join(', ')}`;
    }
  }
  return null;
}

function checkEnum(value, allowed, label) {
  if (allowed.length === 0) return null; // no enum constraint
  if (!allowed.includes(value)) {
    return `${label}: unsupported value "${value}", expected one of: ${allowed.join(', ')}`;
  }
  return null;
}

function checkNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${label}: must be a non-empty string`;
  }
  return null;
}

function checkUniqueStrings(arr, label) {
  if (!Array.isArray(arr)) return `${label}: must be an array`;
  const seen = new Set();
  for (const item of arr) {
    const err = checkNonEmptyString(item, `${label} item`);
    if (err) return err;
    if (seen.has(item)) return `${label}: duplicate entry "${item}"`;
    seen.add(item);
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateTopLevel(config) {
  const errors = [];
  for (const [field, def] of Object.entries(FIELD_SCHEMA)) {
    if (def.required) {
      const err = checkRequired(config, field, def);
      if (err) { errors.push(err); continue; }
    } else if (field in config) {
      const err = checkType(config[field], def.type, field);
      if (err) errors.push(err);
    }
  }
  // Reject unknown top-level fields
  for (const key of Object.keys(config)) {
    if (!(key in FIELD_SCHEMA)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  return errors;
}

function validateRequirementsCompat(rc) {
  const errors = [];
  const err = checkUniqueStrings(rc.supported_schemas, 'requirements_compatibility.supported_schemas');
  if (err) { errors.push(err); return errors; }
  for (const s of rc.supported_schemas) {
    if (!SUPPORTED_SCHEMAS.includes(s)) {
      errors.push(`requirements_compatibility.supported_schemas: unsupported schema "${s}"`);
    }
  }
  const perr = checkUniqueStrings(rc.supported_profiles, 'requirements_compatibility.supported_profiles');
  if (perr) { errors.push(perr); return errors; }
  for (const p of rc.supported_profiles) {
    if (!SUPPORTED_PROFILES.includes(p)) {
      errors.push(`requirements_compatibility.supported_profiles: unsupported profile "${p}"`);
    }
  }
  // Reject unknown nested fields
  for (const key of Object.keys(rc)) {
    if (!['supported_schemas', 'supported_profiles'].includes(key)) {
      errors.push(`requirements_compatibility: unknown field "${key}"`);
    }
  }
  return errors;
}

function validateNestedObject(obj, fieldMap, prefix) {
  const errors = [];
  for (const [field, def] of Object.entries(fieldMap)) {
    if (!(field in obj)) {
      errors.push(`${prefix}.${field}: missing required field`);
      continue;
    }
    const err = checkType(obj[field], def.type, `${prefix}.${field}`);
    if (err) { errors.push(err); continue; }
    if (def.allowed) {
      const cerr = checkEnum(obj[field], def.allowed, `${prefix}.${field}`);
      if (cerr) errors.push(cerr);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!(key in fieldMap)) {
      errors.push(`${prefix}: unknown field "${key}"`);
    }
  }
  return errors;
}

export function validatePlatformConfig(config) {
  const errors = [];

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return ['root: expected a JSON object'];
  }

  errors.push(...validateTopLevel(config));
  if (errors.length > 0) return errors;

  errors.push(...validateRequirementsCompat(config.requirements_compatibility));

  const nestedFields = {
    origin: {
      scheme: { type: 'string', allowed: ['app', 'https'] },
      host: { type: 'string', allowed: [] },
      stability: { type: 'string', allowed: ORIGIN_STABILITIES },
    },
    network: {
      policy: { type: 'string', allowed: NETWORK_POLICIES },
      allowed_schemes: { type: 'object' }, // validated separately
    },
    assets: {
      source: { type: 'string', allowed: ASSET_SOURCES },
      delivery: { type: 'string', allowed: ASSET_DELIVERIES },
    },
    workers: {
      available: { type: 'boolean', allowed: [] },
      framework: { type: 'string', allowed: WORKER_FRAMEWORKS },
    },
    storage: {
      mechanism: { type: 'string', allowed: STORAGE_MECHANISMS },
      partition: { type: 'string', allowed: STORAGE_PARTITIONS },
    },
    security_context: {
      mechanism: { type: 'string', allowed: SECURITY_MECHANISMS },
    },
    bridge: {
      provenance: { type: 'string', allowed: BRIDGE_PROVENANCES },
      origin_validation: { type: 'string', allowed: BRIDGE_ORIGIN_VALIDATIONS },
    },
    entrypoint: {
      source: { type: 'string', allowed: ENTRYPOINT_SOURCES },
      fallback: { type: 'string', allowed: ENTRYPOINT_FALLBACKS },
    },
  };

  for (const [section, fieldMap] of Object.entries(nestedFields)) {
    errors.push(...validateNestedObject(config[section], fieldMap, section));
  }

  // Validate network.allowed_schemes
  const ns = config.network?.allowed_schemes;
  if (ns) {
    const nerr = checkUniqueStrings(ns, 'network.allowed_schemes');
    if (nerr) errors.push(nerr);
    const validSchemes = ['app', 'https'];
    for (const s of (ns || [])) {
      if (!validSchemes.includes(s)) {
        errors.push(`network.allowed_schemes: unsupported scheme "${s}"`);
      }
    }
  }

  // Validate host (non-empty string, no enum constraint)
  if (config.origin?.host) {
    const herr = checkNonEmptyString(config.origin.host, 'origin.host');
    if (herr) errors.push(herr);
  }

  // Platform-specific mechanism checks
  if (config.platform === 'android-webview') {
    if (config.assets?.delivery === 'custom-scheme-handler') {
      errors.push('assets.delivery: "custom-scheme-handler" is iOS-only, use "webview-asset-loader" for Android');
    }
    if (config.origin?.scheme === 'app') {
      errors.push('origin.scheme: "app" is iOS-only, use "https" for Android WebViewAssetLoader');
    }
    if (config.security_context?.mechanism === 'custom-scheme-tls-like') {
      errors.push('security_context.mechanism: "custom-scheme-tls-like" is iOS-only, use "https-tls-like" for Android');
    }
    if (config.storage?.partition === 'fixed-namespace') {
      errors.push('storage.partition: "fixed-namespace" is iOS-only, use "fixed-path-prefix" for Android');
    }
    if (config.entrypoint?.source === 'manifest-declared') {
      errors.push('entrypoint.source: "manifest-declared" is iOS-only (Android uses deterministic-constant)');
    }
  }

  return errors;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2] || DEFAULT_PATH;
  if (!existsSync(filePath)) {
    console.error(`[validate-runtime-platform-config] file not found: ${filePath}`);
    process.exit(2);
  }
  const raw = await readFile(filePath, 'utf-8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.error(`[validate-runtime-platform-config] invalid JSON: ${e.message}`);
    process.exit(1);
  }
  const errors = validatePlatformConfig(config);
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`[validate-runtime-platform-config] ${err}`);
    }
    process.exit(1);
  }
  console.error(`[validate-runtime-platform-config] Structurally valid: ${filePath}`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main();
}

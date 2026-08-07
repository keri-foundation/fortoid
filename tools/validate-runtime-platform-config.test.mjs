// ── validate-runtime-platform-config.test.mjs ────────────────────────────────
// Structural tests for the Android platform configuration validator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_GOOD_PATH = path.resolve(__dirname, '..', 'runtime-platform-config.json');

// Dynamic import because the validator uses ESM exports
const { validatePlatformConfig } = await import('./validate-runtime-platform-config.mjs');

function loadGood() {
  return JSON.parse(readFileSync(KNOWN_GOOD_PATH, 'utf-8'));
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Positive ─────────────────────────────────────────────────────────────────

describe('validatePlatformConfig', () => {
  it('checked-in Android configuration passes', () => {
    const config = loadGood();
    const errors = validatePlatformConfig(config);
    assert.deepStrictEqual(errors, []);
  });

  it('equivalent parsed configuration passes deterministically', () => {
    const config = clone(loadGood());
    const errors = validatePlatformConfig(config);
    assert.deepStrictEqual(errors, []);
  });
});

// ── Negative — top-level ─────────────────────────────────────────────────────

describe('top-level validation', () => {
  it('rejects malformed JSON (non-object)', () => {
    const errors = validatePlatformConfig('not an object');
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('object')));
  });

  it('rejects missing required field', () => {
    const config = loadGood();
    delete config.platform;
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('platform')));
  });

  it('rejects unknown top-level field', () => {
    const config = loadGood();
    config.extra_field = 'nope';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('extra_field')));
  });

  it('rejects wrong schema', () => {
    const config = loadGood();
    config.schema = 'wrong.schema';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('schema')));
  });

  it('rejects wrong version', () => {
    const config = loadGood();
    config.version = 99;
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('version')));
  });

  it('rejects wrong platform', () => {
    const config = loadGood();
    config.platform = 'samsung-tizen';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('platform')));
  });
});

// ── Negative — nested ────────────────────────────────────────────────────────

describe('nested validation', () => {
  it('rejects wrong nested type', () => {
    const config = loadGood();
    config.workers.available = 'yes'; // should be boolean
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('workers.available') && e.includes('boolean')));
  });

  it('rejects unsupported mechanism enum', () => {
    const config = loadGood();
    config.bridge.provenance = 'any-frame';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('bridge.provenance')));
  });

  it('rejects unknown nested field', () => {
    const config = loadGood();
    config.origin.extra_prop = true;
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('origin') && e.includes('extra_prop')));
  });

  it('rejects duplicate list entry in supported_schemas', () => {
    const config = loadGood();
    config.requirements_compatibility.supported_schemas = [
      'fort.runtime-requirements.v1',
      'fort.runtime-requirements.v1',
    ];
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('rejects empty string in allowed_schemes', () => {
    const config = loadGood();
    config.network.allowed_schemes.push('');
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('non-empty') || e.includes('allowed_schemes')));
  });
});

// ── Android-specific ─────────────────────────────────────────────────────────

describe('Android mechanism enforcement', () => {
  it('rejects iOS custom-scheme-handler on Android', () => {
    const config = loadGood();
    config.platform = 'android-webview';
    config.assets.delivery = 'custom-scheme-handler';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('custom-scheme-handler')));
  });

  it('rejects iOS app scheme on Android', () => {
    const config = loadGood();
    config.platform = 'android-webview';
    config.origin.scheme = 'app';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('origin.scheme')));
  });

  it('rejects iOS custom-scheme-tls-like on Android', () => {
    const config = loadGood();
    config.platform = 'android-webview';
    config.security_context.mechanism = 'custom-scheme-tls-like';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('security_context.mechanism')));
  });

  it('rejects iOS manifest-declared entrypoint on Android', () => {
    const config = loadGood();
    config.platform = 'android-webview';
    config.entrypoint.source = 'manifest-declared';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('entrypoint.source')));
  });

  it('rejects payload-missing-placeholder fallback (obsolete)', () => {
    const config = loadGood();
    config.entrypoint.fallback = 'payload-missing-placeholder';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('entrypoint.fallback') || e.includes('fallback')));
  });

  it('rejects iOS fixed-namespace storage partition on Android', () => {
    const config = loadGood();
    config.platform = 'android-webview';
    config.storage.partition = 'fixed-namespace';
    const errors = validatePlatformConfig(config);
    assert.ok(errors.some(e => e.includes('storage.partition')));
  });
});

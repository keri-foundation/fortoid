// ── validate-runtime-requirements-compatibility.test.mjs ──────────────────
// Executable tests for the runtime-requirements compatibility validator.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { validateCompatibility } from './validate-runtime-requirements-compatibility.mjs';

const FIXTURE_DIR = path.join(tmpdir(), `fortoid-compat-test-${Date.now()}`);
const REPO_ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const REAL_CONFIG = path.join(REPO_ROOT, 'runtime-platform-config.json');

let _seq = 0;
function seq() { return _seq++; }

const REAL_RR = {
  schema: 'fort.runtime-requirements.v1',
  version: 1,
  producer: 'fortweb',
  payload_profile: 'offline-runtime',
  capabilities: {
    stable_origin_across_launches: { required: true, description: 'origin stable' },
    persistent_storage_partition: { required: true, description: 'storage persists' },
    secure_context: { required: true, description: 'secure context' },
    remote_network_prohibition: { required: true, description: 'no network' },
    bundled_assets_only: { required: true, description: 'bundled only' },
    worker_availability: { required: true, description: 'workers available' },
    main_frame_provenance: { required: true, description: 'main frame only' },
    origin_provenance: { required: true, description: 'origin check' },
    deterministic_entrypoint: { required: true, description: 'deterministic entry' },
    no_fallback_shell_substitution: { required: true, description: 'no fallback' },
  },
  forbidden_behaviors: ['network_fetch', 'service_worker_registration', 'general_purpose_browsing', 'localhost_or_loopback_origin', 'http_fallback'],
};

async function stageFixture(label, rrOverrides = {}, configContent = null) {
  const dir = path.join(FIXTURE_DIR, `fixture-${seq()}-${label}`);
  await mkdir(dir, { recursive: true });

  const rr = { ...REAL_RR, ...rrOverrides };
  const manifest = {
    package_name: 'fortweb-runtime',
    producer: 'fortweb',
    payload_profile: 'offline-runtime',
    contracts: { runtime_requirements: { path: 'contracts/runtime-requirements.json' } },
  };

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await mkdir(path.join(dir, 'contracts'), { recursive: true });
  await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), JSON.stringify(rr, null, 2));

  if (configContent !== null) {
    await writeFile(path.join(dir, 'runtime-platform-config.json'), typeof configContent === 'string' ? configContent : JSON.stringify(configContent, null, 2));
  }

  return { dir, rr, manifest };
}

before(async () => { await mkdir(FIXTURE_DIR, { recursive: true }); });
after(async () => { await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {}); });

// ═══════════════════════════════════════════════════════════════════════════
// Structural validation
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCompatibility — structural', () => {
  it('1. actual pinned FortWeb requirements produce evidence-backed result', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    assert.ok(typeof r.compatible === 'boolean');
    assert.ok(Array.isArray(r.capabilities));
    assert.ok(Array.isArray(r.forbidden_behaviors));
    assert.ok(r.capabilities.length >= 10);
    assert.ok(r.forbidden_behaviors.length >= 5);
    // Every capability result has the required fields
    for (const c of r.capabilities) {
      assert.ok(typeof c.capability === 'string');
      assert.ok(typeof c.compatible === 'boolean');
      assert.ok(typeof c.evidence === 'string');
    }
  });

  it('2. missing manifest fails', async () => {
    const { dir } = await stageFixture('no-mf');
    await rm(path.join(dir, 'manifest.json'));
    const r = await validateCompatibility(dir);
    assert.ok(r.some ? r.some(e => e.message.includes('manifest.json not found')) : r.errors?.some(e => e.message.includes('manifest.json not found')));
  });

  it('3. invalid manifest UTF-8 fails', async () => {
    const { dir } = await stageFixture('bad-mf-utf8');
    await writeFile(path.join(dir, 'manifest.json'), Buffer.from([0xFF, 0xFE, 0xFD]));
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('manifest.json')));
  });

  it('4. missing typed descriptor fails', async () => {
    const { dir } = await stageFixture('no-desc');
    const mf = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'));
    delete mf.contracts;
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(mf));
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('runtime_requirements')));
  });

  it('5. unsafe descriptor path fails', async () => {
    const { dir } = await stageFixture('unsafe-desc');
    const mf = { package_name: 'fortweb-runtime', producer: 'fortweb', payload_profile: 'offline-runtime', contracts: { runtime_requirements: { path: '../escape.json' } } };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(mf));
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('unexpected')));
  });

  it('6. missing requirements artifact fails', async () => {
    const { dir } = await stageFixture('no-rr');
    await rm(path.join(dir, 'contracts/runtime-requirements.json'));
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('not found')));
  });

  it('7. invalid requirements UTF-8 fails', async () => {
    const { dir } = await stageFixture('bad-rr-utf8');
    await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), Buffer.from([0xFF, 0xFE]));
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('runtime-requirements')));
  });

  it('8. U+FFFD in requirements fails', async () => {
    const { dir } = await stageFixture('rr-fffd');
    await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), '{"schema":"x","producer":"fortweb","payload_profile":"offline-runtime",\uFFFD:"bad"}');
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('U+FFFD')));
  });

  it('9. malformed requirements JSON fails', async () => {
    const { dir } = await stageFixture('bad-rr-json');
    await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), '{not json');
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('runtime-requirements')));
  });

  it('10. wrong schema fails', async () => {
    const { dir } = await stageFixture('bad-schema', { schema: 'wrong.v1' });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('schema')));
  });

  it('11. wrong producer fails', async () => {
    const { dir } = await stageFixture('bad-producer', { producer: 'ios' });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('producer')));
  });

  it('12. unsupported payload profile fails', async () => {
    const { dir } = await stageFixture('bad-profile', { payload_profile: 'online' });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('profile')));
  });

  it('13. missing config fails', async () => {
    const { dir } = await stageFixture('no-config');
    const nonexistentCfg = path.join(dir, 'does-not-exist.json');
    const r = await validateCompatibility(dir, nonexistentCfg);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('platform config not found')), `expected missing-config error, got: ${JSON.stringify(errs)}`);
  });

  it('13a. missing version fails', async () => {
    const { dir } = await stageFixture('no-version', { version: undefined });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('version')), `expected version error, got: ${JSON.stringify(errs)}`);
  });

  it('13b. wrong version fails', async () => {
    const { dir } = await stageFixture('wrong-version', { version: 2 });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('version')), `expected version error, got: ${JSON.stringify(errs)}`);
  });

  it('13c. non-integer version fails', async () => {
    const { dir } = await stageFixture('string-version', { version: '1' });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('version')), `expected version error, got: ${JSON.stringify(errs)}`);
  });

  it('14. invalid config schema fails', async () => {
    const { dir } = await stageFixture('bad-cfg-schema', {}, { schema: 'wrong.cfg.v1', platform: 'android-webview' });
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('unsupported config schema')));
  });

  it('15. wrong config platform fails', async () => {
    const { dir } = await stageFixture('bad-cfg-platform', {}, { schema: 'fort.runtime-platform-config.v1', platform: 'ios-wkwebview' });
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('unexpected platform')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability predicate tests
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCompatibility — capabilities', () => {
  it('16. missing required producer capability fails', async () => {
    // Remove persistent_storage_partition from declared capabilities.
    // Canonical enforcement must reject the incomplete vocabulary.
    const reduced = { ...REAL_RR.capabilities };
    delete reduced.persistent_storage_partition;
    const { dir } = await stageFixture('missing-cap', { capabilities: reduced });
    const r = await validateCompatibility(dir);
    const caps = r.capabilities || [];
    const psp = caps.find(c => c.capability === 'persistent_storage_partition');
    assert.ok(psp, 'persistent_storage_partition must be reported as missing');
    assert.ok(!psp.compatible, 'missing canonical capability must fail');
    assert.ok(psp.reason.includes('missing required'), `expected missing-required, got: ${psp.reason}`);
  });

  it('16a. malformed capability (required: false) fails', async () => {
    const caps = { ...REAL_RR.capabilities, stable_origin_across_launches: { required: false, description: 'x' } };
    const { dir } = await stageFixture('malformed-cap', { capabilities: caps });
    const r = await validateCompatibility(dir);
    const c = r.capabilities?.find(x => x.capability === 'stable_origin_across_launches');
    assert.ok(c, 'must evaluate capability');
    assert.ok(!c.compatible, 'required: false must fail');
    assert.ok(c.reason.includes('malformed'), `expected malformed, got: ${c.reason}`);
  });

  it('17. unknown capability identifier fails', async () => {
    const { dir } = await stageFixture('unknown-cap', { capabilities: { ...REAL_RR.capabilities, unknown_thing: { required: true, description: '???' } } });
    const r = await validateCompatibility(dir);
    const caps = r.capabilities || [];
    const unk = caps.find(c => c.capability === 'unknown_thing');
    assert.ok(unk, 'unknown capability must appear in results');
    assert.ok(!unk.compatible, 'unknown capability must fail');
    assert.ok(unk.reason.includes('unknown') || unk.reason.includes('no predicate'));
  });

  it('18. persistent_storage_partition is PROVEN', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    const psp = r.capabilities?.find(c => c.capability === 'persistent_storage_partition');
    assert.ok(psp, 'persistent_storage_partition must exist');
    assert.ok(psp.compatible, 'must be SATISFIED');
    assert.ok(psp.evidence === 'HOSTED PROVEN', `expected HOSTED PROVEN, got ${psp.evidence}`);
  });

  it('19. worker_availability is PROVEN', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    const wa = r.capabilities?.find(c => c.capability === 'worker_availability');
    assert.ok(wa, 'worker_availability must exist');
    assert.ok(wa.compatible, 'must be SATISFIED');
    assert.ok(wa.evidence === 'HOSTED PROVEN', `expected HOSTED PROVEN, got ${wa.evidence}`);
  });

  it('20. no_fallback_shell_substitution is SATISFIED with fallback:none', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    const nf = r.capabilities?.find(c => c.capability === 'no_fallback_shell_substitution');
    assert.ok(nf, 'no_fallback_shell_substitution must exist');
    assert.ok(nf.compatible, 'must be SATISFIED with fallback:none');
    assert.ok(nf.evidence !== 'CONTRADICTED', 'must not be CONTRADICTED');
  });

  it('20a. no_fallback_shell_substitution rejects payload-missing-placeholder', async () => {
    const cfg = JSON.parse(await readFile(REAL_CONFIG, 'utf-8'));
    cfg.entrypoint.fallback = 'payload-missing-placeholder';
    const { dir } = await stageFixture('fallback-contradicted', {}, cfg);
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const nf = r.capabilities?.find(c => c.capability === 'no_fallback_shell_substitution');
    assert.ok(nf, 'must evaluate');
    assert.ok(!nf.compatible, 'payload-missing-placeholder must be rejected');
    assert.ok(nf.evidence === 'CONTRADICTED', `expected CONTRADICTED, got ${nf.evidence}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Forbidden-behavior predicate tests
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCompatibility — forbidden behaviors', () => {
  it('21. unknown forbidden behavior fails', async () => {
    const { dir } = await stageFixture('unknown-fb', {}, { schema: 'fort.runtime-platform-config.v1', platform: 'android-webview', requirements_compatibility: { supported_schemas: ['fort.runtime-requirements.v1'], supported_profiles: ['offline-runtime'] } });
    const rr = { ...REAL_RR, forbidden_behaviors: [...REAL_RR.forbidden_behaviors, 'unknown_fb'] };
    await writeFile(path.join(dir, 'contracts/runtime-requirements.json'), JSON.stringify(rr));
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const fbs = r.forbidden_behaviors || [];
    const unk = fbs.find(f => f.forbidden_behavior === 'unknown_fb');
    assert.ok(unk, 'unknown forbidden behavior must appear');
    assert.ok(!unk.compatible, 'must fail');
  });

  it('22. service_worker_registration requires host prohibition', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    const sw = r.forbidden_behaviors?.find(f => f.forbidden_behavior === 'service_worker_registration');
    assert.ok(sw, 'service_worker_registration must be evaluated');
    assert.ok(sw.compatible, 'service_worker_registration must be SATISFIED by explicit host prohibition');
    assert.ok(sw.evidence === 'STATICALLY-VERIFIED', `expected STATICALLY-VERIFIED, got ${sw.evidence}`);
  });

  it('22c. service_worker_registration without host prohibition fails', async () => {
    const cfg = JSON.parse(await readFile(REAL_CONFIG, 'utf-8'));
    delete cfg.workers.service_worker_registration;
    const { dir } = await stageFixture('sw-missing', {}, cfg);
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const sw = r.forbidden_behaviors?.find(f => f.forbidden_behavior === 'service_worker_registration');
    assert.ok(sw, 'must evaluate');
    assert.ok(!sw.compatible, 'missing host prohibition must fail');
    assert.ok(sw.evidence === 'config', `expected config evidence, got ${sw.evidence}`);
  });

  it('22d. service_worker_registration with permissive policy fails', async () => {
    const cfg = JSON.parse(await readFile(REAL_CONFIG, 'utf-8'));
    cfg.workers.service_worker_registration = 'allowed';
    const { dir } = await stageFixture('sw-allowed', {}, cfg);
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const sw = r.forbidden_behaviors?.find(f => f.forbidden_behavior === 'service_worker_registration');
    assert.ok(sw, 'must evaluate');
    assert.ok(!sw.compatible, 'permissive policy must fail');
  });

  it('22a. missing forbidden behavior from vocabulary fails', async () => {
    const reduced = REAL_RR.forbidden_behaviors.filter(f => f !== 'network_fetch');
    const { dir } = await stageFixture('missing-fb', { forbidden_behaviors: reduced });
    const r = await validateCompatibility(dir);
    const nf = r.forbidden_behaviors?.find(f => f.forbidden_behavior === 'network_fetch');
    assert.ok(nf, 'network_fetch must be reported as missing');
    assert.ok(!nf.compatible, 'missing canonical FB must fail');
    assert.ok(nf.reason.includes('missing required'), `expected missing-required, got: ${nf.reason}`);
  });

  it('22b. duplicate forbidden behaviors fail', async () => {
    const dups = [...REAL_RR.forbidden_behaviors, 'network_fetch'];
    const { dir } = await stageFixture('dup-fb', { forbidden_behaviors: dups });
    const r = await validateCompatibility(dir);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('duplicates')), `expected duplicates error, got: ${JSON.stringify(errs)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCompatibility — edge cases', () => {
  it('23. missing requirements_compatibility fails', async () => {
    const { dir } = await stageFixture('no-rc', {}, { schema: 'fort.runtime-platform-config.v1', platform: 'android-webview' });
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('requirements_compatibility')));
  });

  it('24. missing capabilities object fails', async () => {
    const { dir } = await stageFixture('no-caps', { capabilities: undefined }, { schema: 'fort.runtime-platform-config.v1', platform: 'android-webview', requirements_compatibility: { supported_schemas: ['fort.runtime-requirements.v1'], supported_profiles: ['offline-runtime'] } });
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('capabilities') || e.message.includes('not an object')));
  });

  it('25. missing forbidden_behaviors fails', async () => {
    const { dir } = await stageFixture('no-fb', { forbidden_behaviors: undefined }, { schema: 'fort.runtime-platform-config.v1', platform: 'android-webview', requirements_compatibility: { supported_schemas: ['fort.runtime-requirements.v1'], supported_profiles: ['offline-runtime'] } });
    const cfgPath = path.join(dir, 'runtime-platform-config.json');
    const r = await validateCompatibility(dir, cfgPath);
    const errs = r.errors || r;
    assert.ok(errs.some(e => e.message.includes('forbidden_behaviors')));
  });

  it('26. overall result is COMPATIBLE (all gaps resolved)', async () => {
    const r = await validateCompatibility(path.join(REPO_ROOT, 'app/src/main/assets/payload'));
    assert.strictEqual(r.compatible, true, 'must be COMPATIBLE — all prior UNPROVEN gaps are now PROVEN');
    // all 10 capabilities SATISFIED
    const satCaps = r.capabilities.filter(c => c.compatible).length;
    assert.ok(satCaps >= 10, `expected >=10 SATISFIED capabilities, got ${satCaps}`);
    // no_fallback_shell_substitution must be SATISFIED
    const nf = r.capabilities.find(c => c.capability === 'no_fallback_shell_substitution');
    assert.ok(nf?.compatible, 'no_fallback_shell_substitution must be SATISFIED');
  });
});

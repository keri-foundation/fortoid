// ── import-fortweb-runtime-package.test.mjs ─────────────────────────────────
// Executable tests for the Android FortWeb runtime package importer.
// Uses small programmatically-built ZIP fixtures to avoid checked-in binaries.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateEntries,
  validateManifestIdentity,
  validateManifestLock,
  validateManifestFiles,
  validateManifestContracts,
  validateChecksums,
  validateRuntimeRequirements,
  activatePayload,
  importPackage,
} from './import-fortweb-runtime-package.mjs';
import { verifyPayload } from './verify-packaged-runtime.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(tmpdir(), `fortoid-import-test-${Date.now()}`);
let testSeq = 0;

function nextDir(label) {
  const d = path.join(FIXTURE_DIR, `${testSeq++}-${label}`);
  return d;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function writeJson(filePath, obj) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

function makeManifest(overrides = {}) {
  const seq = testSeq;
  return {
    schema_version: '1.0.0',
    package_version: '0.0.0',
    package_name: 'fortweb-runtime',
    producer: 'fortweb',
    payload_profile: 'offline-runtime',
    fortweb_commit_sha: 'a'.repeat(40),
    runtime_origin: 'https://appassets.androidplatform.net',
    entrypoint: 'app/index.html',
    contracts: {
      runtime_requirements: { path: 'contracts/runtime-requirements.json' },
    },
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(`idx-${seq}`)), bytes: `idx-${seq}`.length },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(`rr-${seq}`)), bytes: `rr-${seq}`.length },
    ],
    ...overrides,
  };
}

function makeRR(overrides = {}) {
  return {
    schema: 'fort.runtime-requirements.v2',
    version: 2,
    producer: 'fortweb',
    payload_profile: 'offline-runtime',
    capabilities: [],
    forbidden_behaviors: [],
    ...overrides,
  };
}

async function makeZip(dir, files) {
  // files: { [relPath]: string | Buffer }
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, content);
  }
  const zipPath = path.join(dir, 'package.zip');
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: dir, timeout: 10000 });
  return zipPath;
}

async function makeCanonicalZip(dir, { checksumsFor, extraPayload, unlistedPayload } = {}) {
  const rrContent = JSON.stringify(makeRR());
  const idxContent = `idx-${testSeq}`;
  // The staged-payload gate requires these entries, so the canonical fixture
  // carries them: a package that omits them is not an acceptable package.
  const payload = {
    'app/index.html': idxContent,
    'app/app/main.js': `main-${testSeq}`,
    'pyscript-ci.toml': '[fort_runtime_packages]\n',
    'contracts/runtime-requirements.json': rrContent,
    'vendor/pyodide/pyodide.mjs': `pyodide-${testSeq}`,
    'vendor/pyscript/pyscript.js': `pyscript-${testSeq}`,
    'wheels/.keep': `wheel-${testSeq}`,
    ...(extraPayload || {}),
  };
  const manifestContent = JSON.stringify({
    ...makeManifest(),
    files: Object.entries(payload).map(([rel, content]) => ({
      path: rel,
      sha256: sha256(Buffer.from(content)),
      bytes: Buffer.byteLength(content),
    })),
  });
  // FortWeb checksums.sha256 contains only the manifest's own digest
  const manifestDigest = sha256(Buffer.from(manifestContent));
  const files = {
    'fortweb-runtime/manifest.json': manifestContent,
    'fortweb-runtime/checksums.sha256': checksumsFor
      ? checksumsFor(manifestDigest)
      : `${manifestDigest}  manifest.json\n`,
  };
  for (const [rel, content] of Object.entries(payload)) {
    files[`fortweb-runtime/${rel}`] = content;
  }
  // Files present in the archive but deliberately absent from manifest.files,
  // for exercising the inventory-closure rejection.
  for (const [rel, content] of Object.entries(unlistedPayload || {})) {
    files[`fortweb-runtime/${rel}`] = content;
  }
  const manifest = JSON.parse(manifestContent);
  return { zipPath: await makeZip(dir, files), manifest, dir };
}

before(async () => {
  await mkdir(FIXTURE_DIR, { recursive: true });
});

after(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
});

// ── Entry safety ────────────────────────────────────────────────────────────

describe('validateEntries', () => {
  it('accepts safe relative paths', () => {
    assert.deepStrictEqual(validateEntries(['app/index.html', 'manifest.json']), []);
  });
  it('rejects absolute path', () => {
    const e = validateEntries(['/etc/passwd']);
    assert.ok(e.some(m => m.includes('unsafe')));
  });
  it('rejects traversal path', () => {
    const e = validateEntries(['../outside']);
    assert.ok(e.some(m => m.includes('unsafe')));
  });
  it('rejects backslash path', () => {
    const e = validateEntries(['app\\windows']);
    assert.ok(e.some(m => m.includes('unsafe')));
  });
  it('rejects duplicate entries', () => {
    const e = validateEntries(['app/x', 'app/x']);
    assert.ok(e.some(m => m.includes('duplicate')));
  });
});

// ── Manifest validation ─────────────────────────────────────────────────────

describe('validateManifestIdentity', () => {
  it('accepts valid manifest', () => {
    assert.deepStrictEqual(validateManifestIdentity(makeManifest()), []);
  });
  it('rejects wrong package_name', () => {
    const e = validateManifestIdentity(makeManifest({ package_name: 'wrong' }));
    assert.ok(e.some(m => m.includes('package_name')));
  });
  it('rejects wrong producer', () => {
    const e = validateManifestIdentity(makeManifest({ producer: 'ios' }));
    assert.ok(e.some(m => m.includes('producer')));
  });
  it('rejects non-object', () => {
    const e = validateManifestIdentity('not-obj');
    assert.ok(e.some(m => m.includes('JSON object')));
  });
});

describe('validateManifestFiles', () => {
  it('accepts valid files array', () => {
    assert.deepStrictEqual(validateManifestFiles(makeManifest()), []);
  });
  it('rejects non-array files', () => {
    const e = validateManifestFiles({ files: { not: 'array' } });
    assert.ok(e.some(m => m.includes('must be an array')));
  });
  it('rejects duplicate path', () => {
    const m = makeManifest();
    m.files.push({ ...m.files[0] });
    const e = validateManifestFiles(m);
    assert.ok(e.some(m => m.includes('duplicate path')));
  });
  it('rejects unsafe path', () => {
    const m = makeManifest();
    m.files[0].path = '../nope';
    const e = validateManifestFiles(m);
    assert.ok(e.some(m => m.includes('unsafe path')));
  });
  it('rejects invalid sha256', () => {
    const m = makeManifest();
    m.files[0].sha256 = 'short';
    const e = validateManifestFiles(m);
    assert.ok(e.some(m => m.includes('sha256')));
  });
  it('rejects negative bytes', () => {
    const m = makeManifest();
    m.files[0].bytes = -1;
    const e = validateManifestFiles(m);
    assert.ok(e.some(m => m.includes('bytes')));
  });
});

describe('validateManifestContracts', () => {
  it('accepts valid contracts', () => {
    assert.deepStrictEqual(validateManifestContracts(makeManifest()), []);
  });
  it('rejects missing contracts', () => {
    const e = validateManifestContracts({});
    assert.ok(e.some(m => m.includes('missing')));
  });
  it('rejects non-conventional RR path', () => {
    const m = makeManifest();
    m.contracts.runtime_requirements.path = 'other/path.json';
    const e = validateManifestContracts(m);
    assert.ok(e.some(m => m.includes('expected')));
  });
});

// ── Checksum validation ────────────────────────────────────────────────────

describe('validateChecksums', () => {
  it('accepts matching checksums', async () => {
    const { zipPath, manifest, dir: fixtureDir } = await makeCanonicalZip(nextDir('cs-ok'));
    const errors = await validateChecksums(
      path.join(fixtureDir, 'fortweb-runtime/checksums.sha256'),
      path.join(fixtureDir, 'fortweb-runtime'),
      manifest,
    );
    assert.deepStrictEqual(errors, []);
  });

  it('rejects mismatched manifest digest in checksums', async () => {
    const m = makeManifest();
    m.files = [{ path: 'app/index.html', sha256: sha256(Buffer.from('x')), bytes: 1 }];
    const manifestContent = JSON.stringify(m);
    const zipDir = nextDir('cs-bad');
    await mkdir(path.join(zipDir, 'fortweb-runtime/app'), { recursive: true });
    await writeFile(path.join(zipDir, 'fortweb-runtime/manifest.json'), manifestContent);
    await writeFile(path.join(zipDir, 'fortweb-runtime/app/index.html'), 'x');
    // Wrong checksum: different digest
    await writeFile(path.join(zipDir, 'fortweb-runtime/checksums.sha256'), `${'0'.repeat(64)}  manifest.json\n`);
    const errors = await validateChecksums(
      path.join(zipDir, 'fortweb-runtime/checksums.sha256'),
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('manifest digest mismatch') || e.includes('digest mismatch')));
  });

  it('rejects byte count mismatch in manifest.files', async () => {
    const zipDir = nextDir('cs-bad-bytes');
    const content = 'hello';
    const m = makeManifest();
    m.files = [{ path: 'app/index.html', sha256: sha256(Buffer.from(content)), bytes: 9999 }];
    await mkdir(path.join(zipDir, 'fortweb-runtime/app'), { recursive: true });
    const manifestContent = JSON.stringify(m);
    await writeFile(path.join(zipDir, 'fortweb-runtime/manifest.json'), manifestContent);
    await writeFile(path.join(zipDir, 'fortweb-runtime/app/index.html'), content);
    await writeFile(path.join(zipDir, 'fortweb-runtime/checksums.sha256'),
      `${sha256(Buffer.from(manifestContent))}  manifest.json\n`);
    const errors = await validateChecksums(
      path.join(zipDir, 'fortweb-runtime/checksums.sha256'),
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('byte count')));
  });

  it('rejects empty checksums file', async () => {
    const zipDir = nextDir('cs-empty');
    const m = makeManifest();
    m.files = [{ path: 'app/index.html', sha256: sha256(Buffer.from('x')), bytes: 1 }];
    await mkdir(path.join(zipDir, 'fortweb-runtime/app'), { recursive: true });
    await writeFile(path.join(zipDir, 'fortweb-runtime/manifest.json'), JSON.stringify(m));
    await writeFile(path.join(zipDir, 'fortweb-runtime/app/index.html'), 'x');
    await writeFile(path.join(zipDir, 'fortweb-runtime/checksums.sha256'), '   \n');
    const errors = await validateChecksums(
      path.join(zipDir, 'fortweb-runtime/checksums.sha256'),
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('empty')));
  });
});

// ── Runtime requirements ───────────────────────────────────────────────────

describe('validateRuntimeRequirements', () => {
  it('accepts valid requirements', async () => {
    const { manifest, dir } = await makeCanonicalZip(nextDir('rr-ok'));
    const errors = await validateRuntimeRequirements(
      path.join(dir, 'fortweb-runtime'), manifest,
    );
    assert.deepStrictEqual(errors, []);
  });

  it('rejects invalid UTF-8', async () => {
    const m = makeManifest();
    const zipDir = nextDir('rr-bad-utf8');
    await mkdir(path.join(zipDir, 'fortweb-runtime/contracts'), { recursive: true });
    await writeFile(path.join(zipDir, 'fortweb-runtime/contracts/runtime-requirements.json'), Buffer.from([0xFF, 0xFE, 0xFD]));
    const errors = await validateRuntimeRequirements(
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('invalid UTF-8')));
  });

  it('rejects U+FFFD in content', async () => {
    const m = makeManifest();
    const zipDir = nextDir('rr-fffd');
    // Create a string that has valid UTF-8 bytes but contains a literal U+FFFD
    const badContent = '{"schema":"x","producer":"fortweb","payload_profile":"offline-runtime",\uFFFD:"bad"}';
    await mkdir(path.join(zipDir, 'fortweb-runtime/contracts'), { recursive: true });
    await writeFile(path.join(zipDir, 'fortweb-runtime/contracts/runtime-requirements.json'), badContent);
    const errors = await validateRuntimeRequirements(
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('U+FFFD')));
  });

  it('rejects malformed JSON', async () => {
    const m = makeManifest();
    const zipDir = nextDir('rr-bad-json');
    await mkdir(path.join(zipDir, 'fortweb-runtime/contracts'), { recursive: true });
    await writeFile(path.join(zipDir, 'fortweb-runtime/contracts/runtime-requirements.json'), '{not json');
    const errors = await validateRuntimeRequirements(
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('invalid JSON')));
  });

  it('rejects producer mismatch', async () => {
    const m = makeManifest();
    const zipDir = nextDir('rr-producer');
    await mkdir(path.join(zipDir, 'fortweb-runtime/contracts'), { recursive: true });
    await writeJson(path.join(zipDir, 'fortweb-runtime/contracts/runtime-requirements.json'),
      makeRR({ producer: 'some-other-tool' }));
    const errors = await validateRuntimeRequirements(
      path.join(zipDir, 'fortweb-runtime'), m,
    );
    assert.ok(errors.some(e => e.includes('producer mismatch')));
  });
});

// ── Activation ──────────────────────────────────────────────────────────────

describe('activatePayload', () => {
  it('activates payload successfully', async () => {
    const workDir = nextDir('activation-ok');
    const destDir = path.join(workDir, 'payload');
    const srcDir = path.join(workDir, 'src');
    await mkdir(path.join(srcDir, 'app'), { recursive: true });
    await writeFile(path.join(srcDir, 'app/index.html'), 'content-v1');
    await activatePayload(srcDir, destDir, 'fortweb-runtime');
    assert.strictEqual(await readFile(path.join(destDir, 'app/index.html'), 'utf-8'), 'content-v1');
  });

  it('replaces existing payload successfully', async () => {
    const workDir = nextDir('activation-replace');
    const destDir = path.join(workDir, 'payload');
    const srcDir1 = path.join(workDir, 'src1');
    await mkdir(path.join(srcDir1, 'app'), { recursive: true });
    await writeFile(path.join(srcDir1, 'app/index.html'), 'v1');
    await activatePayload(srcDir1, destDir, 'fortweb-runtime');

    const srcDir2 = path.join(workDir, 'src2');
    await mkdir(path.join(srcDir2, 'app'), { recursive: true });
    await writeFile(path.join(srcDir2, 'app/index.html'), 'v2');
    await activatePayload(srcDir2, destDir, 'fortweb-runtime');
    assert.strictEqual(await readFile(path.join(destDir, 'app/index.html'), 'utf-8'), 'v2');
  });

  it('rolls back and preserves prior payload on injected failure', async () => {
    const workDir = nextDir('activation-rollback');
    const destDir = path.join(workDir, 'payload');

    // First activation — establish known-good payload
    const srcDir1 = path.join(workDir, 'src1');
    await mkdir(path.join(srcDir1, 'app'), { recursive: true });
    await writeFile(path.join(srcDir1, 'app/index.html'), 'original-content');
    await activatePayload(srcDir1, destDir, 'fortweb-runtime');

    // Capture prior state
    const priorFiles = await readdir(destDir, { recursive: true, withFileTypes: true });
    const priorIndex = await readFile(path.join(destDir, 'app/index.html'), 'utf-8');
    assert.strictEqual(priorIndex, 'original-content');

    // Attempt replacement with injected failure
    const srcDir2 = path.join(workDir, 'src2');
    await mkdir(path.join(srcDir2, 'app'), { recursive: true });
    await writeFile(path.join(srcDir2, 'app/index.html'), 'should-never-appear');

    let failureCaught = false;
    try {
      await activatePayload(srcDir2, destDir, 'fortweb-runtime', {
        beforeActivate: async () => { throw new Error('injected activation failure'); },
      });
    } catch (e) {
      failureCaught = true;
      assert.ok(e.message.includes('injected activation failure'));
      assert.ok(e.message.includes('previous payload preserved'));
    }
    assert.ok(failureCaught, 'expected activation to throw');

    // Verify old payload is restored byte-for-byte
    assert.ok(existsSync(path.join(destDir, 'app/index.html')), 'old payload should still exist');
    const restoredIndex = await readFile(path.join(destDir, 'app/index.html'), 'utf-8');
    assert.strictEqual(restoredIndex, 'original-content', 'old payload content must be identical');

    // Verify candidate and backup dirs are cleaned up
    const parentDir = path.dirname(destDir);
    const parentEntries = await readdir(parentDir);
    assert.ok(!parentEntries.some(e => e.startsWith('.payload-candidate')), 'candidate dir should be removed');
    assert.ok(!parentEntries.some(e => e.startsWith('.payload-backup')), 'backup dir should be removed');

    // Verify a subsequent valid activation still succeeds
    const srcDir3 = path.join(workDir, 'src3');
    await mkdir(path.join(srcDir3, 'app'), { recursive: true });
    await writeFile(path.join(srcDir3, 'app/index.html'), 'post-rollback-content');
    await activatePayload(srcDir3, destDir, 'fortweb-runtime');
    assert.strictEqual(await readFile(path.join(destDir, 'app/index.html'), 'utf-8'), 'post-rollback-content');
  });

  it('retains backup on rollback-restoration failure', async () => {
    const workDir = nextDir('activation-rollback-fail');
    const destDir = path.join(workDir, 'payload');

    // First activation — establish known-good payload
    const srcDir1 = path.join(workDir, 'src1');
    await mkdir(path.join(srcDir1, 'app'), { recursive: true });
    await writeFile(path.join(srcDir1, 'app/index.html'), 'original-bytes');
    await activatePayload(srcDir1, destDir, 'fortweb-runtime');
    const priorContent = await readFile(path.join(destDir, 'app/index.html'), 'utf-8');
    assert.strictEqual(priorContent, 'original-bytes');

    // Second activation — afterActivate throws, beforeRollback throws (simulates rollback failure)
    const srcDir2 = path.join(workDir, 'src2');
    await mkdir(path.join(srcDir2, 'app'), { recursive: true });
    await writeFile(path.join(srcDir2, 'app/index.html'), 'should-not-persist');

    let backupPathSeen = null;
    let rollbackFailureCaught = false;
    try {
      await activatePayload(srcDir2, destDir, 'fortweb-runtime', {
        afterActivate: async () => { throw new Error('post-activation failure'); },
        beforeRollback: async function () {
          // Capture the backupDir path from the implementation scope
          // The backup dir is at <parent>/.payload-backup
          const parent = path.dirname(destDir);
          backupPathSeen = path.join(parent, '.payload-backup');
          throw new Error('simulated rollback restoration failure');
        },
      });
    } catch (e) {
      rollbackFailureCaught = true;
      assert.ok(e.message.includes('ROLLBACK FAILED'), `expected ROLLBACK FAILED, got: ${e.message}`);
      assert.ok(e.message.includes('Manual recovery required'), 'must mention manual recovery');
      if (backupPathSeen) {
        assert.ok(e.message.includes(backupPathSeen), `backup path ${backupPathSeen} not in error: ${e.message}`);
      }
    }
    assert.ok(rollbackFailureCaught, 'expected activation to throw');

    // Verify backup directory still exists with original content
    const parentDir = path.dirname(destDir);
    const backupDir = path.join(parentDir, '.payload-backup');
    assert.ok(existsSync(backupDir), 'backup directory must be retained');
    const backupContent = await readFile(path.join(backupDir, 'app/index.html'), 'utf-8');
    assert.strictEqual(backupContent, 'original-bytes', 'backup must contain original bytes');

    // Verify candidate is cleaned up
    assert.ok(!existsSync(path.join(parentDir, '.payload-candidate')), 'candidate dir must be removed');
  });

  it('non-existent dest dir is created', async () => {
    const workDir = nextDir('new-dest');
    const destDir = path.join(workDir, 'nonexistent', 'payload');
    const srcDir = path.join(workDir, 'src');
    await mkdir(path.join(srcDir, 'app'), { recursive: true });
    await writeFile(path.join(srcDir, 'app/index.html'), 'hello');
    await activatePayload(srcDir, destDir, 'fortweb-runtime');
    assert.strictEqual(await readFile(path.join(destDir, 'app/index.html'), 'utf-8'), 'hello');
  });
});

// ── Integration: full import ─────────────────────────────────────────────────

describe('importPackage (integration)', () => {
  it('imports canonical ZIP successfully', async () => {
    const workDir = nextDir('import-ok');
    const destDir = path.join(workDir, 'payload');
    const { zipPath } = await makeCanonicalZip(nextDir('import-ok-zip'));
    const result = await importPackage(zipPath, destDir);
    assert.ok(result.includes('staged'));
    assert.ok(existsSync(path.join(destDir, 'manifest.json')));
    assert.ok(existsSync(path.join(destDir, 'app/index.html')));
    assert.ok(existsSync(path.join(destDir, 'contracts/runtime-requirements.json')));
    assert.ok(existsSync(path.join(destDir, 'checksums.sha256')));
  });

  it('rejects missing manifest', async () => {
    const zipDir = nextDir('no-manifest');
    const { zipPath } = await makeCanonicalZip(zipDir);
    // Create a bad ZIP with no manifest.json
    const badDir = nextDir('bad-no-mf-zip');
    await mkdir(path.join(badDir, 'fortweb-runtime/app'), { recursive: true });
    await writeFile(path.join(badDir, 'fortweb-runtime/app/index.html'), 'x');
    const badZip = path.join(badDir, 'bad.zip');
    execFileSync('zip', ['-q', '-r', badZip, '.'], { cwd: badDir, timeout: 10000 });
    await assert.rejects(
      () => importPackage(badZip, path.join(nextDir('bad-dest'), 'payload')),
      /manifest.json not found/,
    );
  });

  it('rejects wrong package_name', async () => {
    const zipDir = nextDir('bad-name');
    const m = makeManifest({ package_name: 'wrong-pkg' });
    const rr = makeRR();
    const rrContent = JSON.stringify(rr);
    const idxContent = `idx-${testSeq}`;
    m.files = [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ];
    const manifestContent = JSON.stringify(m);
    const files = {
      'fortweb-runtime/manifest.json': manifestContent,
      'fortweb-runtime/checksums.sha256': `${sha256(Buffer.from(manifestContent))}  manifest.json\n`,
      'fortweb-runtime/app/index.html': idxContent,
      'fortweb-runtime/contracts/runtime-requirements.json': rrContent,
    };
    await makeZip(zipDir, files);
    await assert.rejects(
      () => importPackage(path.join(zipDir, 'package.zip'), path.join(nextDir('bad-name-dest'), 'payload')),
      /package_name/,
    );
  });

  it('rejects unlisted file not in manifest inventory', async () => {
    // A canonical package plus one file that manifest.files does not list, so
    // every manifest-listed file resolves and only the closure check can fire.
    const { zipPath } = await makeCanonicalZip(nextDir('extra-file'), {
      unlistedPayload: { 'secret.txt': 'not-in-manifest' },
    });
    await assert.rejects(
      () => importPackage(zipPath, path.join(nextDir('extra-dest'), 'payload')),
      /inventory closure/,
    );
  });

  it('rejects ZIP containing a symlink entry', { skip: process.platform === 'darwin' ? 'macOS unzip does not preserve symlinks from ZIP metadata' : false }, async () => {
    const workDir = nextDir('zip-symlink');
    const destDir = path.join(workDir, 'payload');
    // Build a valid package ZIP first
    const { zipPath: cleanZip } = await makeCanonicalZip(nextDir('symlink-base'));
    const badZip = path.join(workDir, 'with-symlink.zip');
    await mkdir(workDir, { recursive: true });
    // Use Python to clone the ZIP and add a proper Unix symlink entry
    execFileSync('python3', ['-c', `
import zipfile, stat, io, struct
src = '${cleanZip}'
dst = '${badZip}'
with zipfile.ZipFile(src, 'r') as zin:
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        # Add a proper Unix symlink entry with S_IFLNK mode
        info = zipfile.ZipInfo('fortweb-runtime/sneaky-link')
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zout.writestr(info, '/etc/passwd')
`], { timeout: 10000 });
    // Verify symlink entry exists with Unix symlink mode in archive metadata
    const modeOut = execFileSync('python3', ['-c', `
import zipfile, stat, os
with zipfile.ZipFile('${badZip}', 'r') as zf:
    for info in zf.infolist():
        if info.filename == 'fortweb-runtime/sneaky-link':
            mode = info.external_attr >> 16
            is_lnk = stat.S_ISLNK(mode)
            print(f'S_ISLNK={is_lnk} mode={mode:o}')
`], { encoding: 'utf-8', timeout: 10000 });
    assert.ok(modeOut.includes('S_ISLNK=True'), `symlink mode not set in ZIP: ${modeOut}`);

    // On Linux, unzip preserves symlinks; importPackage must reject
    await assert.rejects(
      () => importPackage(badZip, destDir),
      /symlink not allowed|inventory closure/,
    );
  });
});

// ── Lock identity ────────────────────────────────────────────────────────────
// A package is only acceptable when its manifest fortweb_commit_sha equals the
// Fortoid runtime lock (config/fortweb-runtime.json).

describe('validateManifestLock', () => {
  const LOCK = 'a'.repeat(40);

  it('accepts a commit that matches the lock', () => {
    assert.deepStrictEqual(validateManifestLock({ fortweb_commit_sha: LOCK }, LOCK), []);
  });

  it('is a no-op when no lock expectation is supplied', () => {
    assert.deepStrictEqual(validateManifestLock({ fortweb_commit_sha: LOCK }, undefined), []);
    assert.deepStrictEqual(validateManifestLock({ fortweb_commit_sha: LOCK }, null), []);
    assert.deepStrictEqual(validateManifestLock({ fortweb_commit_sha: LOCK }, ''), []);
  });

  it('rejects a manifest commit that does not match the lock', () => {
    const errs = validateManifestLock({ fortweb_commit_sha: LOCK }, 'b'.repeat(40));
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0], /does not match the Fortoid lock/);
  });

  it('rejects a malformed expected lock commit', () => {
    assert.match(validateManifestLock({ fortweb_commit_sha: LOCK }, 'main')[0], /expected FortWeb commit/);
    assert.match(validateManifestLock({ fortweb_commit_sha: LOCK }, 'abc123')[0], /expected FortWeb commit/);
    assert.match(validateManifestLock({ fortweb_commit_sha: LOCK }, 'A'.repeat(40))[0], /expected FortWeb commit/);
  });

  it('rejects a malformed manifest commit', () => {
    assert.match(validateManifestLock({ fortweb_commit_sha: 'not-a-sha' }, LOCK)[0], /fortweb_commit_sha/);
    assert.match(validateManifestLock({ fortweb_commit_sha: 'A'.repeat(40) }, LOCK)[0], /fortweb_commit_sha/);
  });

  it('rejects a missing manifest commit', () => {
    assert.match(validateManifestLock({}, LOCK)[0], /fortweb_commit_sha/);
    assert.match(validateManifestLock({ fortweb_commit_sha: '' }, LOCK)[0], /fortweb_commit_sha/);
  });
});

describe('importPackage lock enforcement', () => {
  const IMPORTER_CLI = 'tools/import-fortweb-runtime-package.mjs';

  it('accepts a package whose commit matches the lock', async () => {
    const workDir = nextDir('lock-match');
    const destDir = path.join(workDir, 'payload');
    const { zipPath, manifest } = await makeCanonicalZip(nextDir('lock-match-zip'));
    const result = await importPackage(zipPath, destDir, {
      expectedFortwebCommit: manifest.fortweb_commit_sha,
    });
    assert.ok(result.includes('staged'));
    assert.ok(existsSync(path.join(destDir, 'manifest.json')));
  });

  it('rejects a mismatched commit before touching the staged payload', async () => {
    const workDir = nextDir('lock-mismatch');
    const destDir = path.join(workDir, 'payload');

    // Establish a known-good payload that must survive the rejected import.
    const srcDir = path.join(workDir, 'prior');
    await mkdir(path.join(srcDir, 'app'), { recursive: true });
    await writeFile(path.join(srcDir, 'app/index.html'), 'known-good');
    await activatePayload(srcDir, destDir, 'fortweb-runtime');

    const { zipPath } = await makeCanonicalZip(nextDir('lock-mismatch-zip'));
    await assert.rejects(
      () => importPackage(zipPath, destDir, { expectedFortwebCommit: 'b'.repeat(40) }),
      /does not match the Fortoid lock/,
    );

    assert.strictEqual(
      await readFile(path.join(destDir, 'app/index.html'), 'utf-8'),
      'known-good',
      'a rejected import must not alter the staged payload',
    );
    const parentEntries = await readdir(path.dirname(destDir));
    assert.ok(!parentEntries.some(e => e.startsWith('.payload-candidate')), 'no candidate residue');
    assert.ok(!parentEntries.some(e => e.startsWith('.payload-backup')), 'no backup residue');
  });

  it('rejects a malformed expected lock commit', async () => {
    const workDir = nextDir('lock-malformed-expected');
    const { zipPath } = await makeCanonicalZip(nextDir('lock-malformed-zip'));
    await assert.rejects(
      () => importPackage(zipPath, path.join(workDir, 'payload'), { expectedFortwebCommit: 'main' }),
      /expected FortWeb commit/,
    );
  });

  async function buildLockVariantZip(label, mutate) {
    const zipDir = nextDir(label);
    const m = makeManifest();
    mutate(m);
    const rrContent = JSON.stringify(makeRR());
    const idxContent = `idx-${testSeq}`;
    m.files = [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ];
    const manifestContent = JSON.stringify(m);
    await makeZip(zipDir, {
      'fortweb-runtime/manifest.json': manifestContent,
      'fortweb-runtime/checksums.sha256': `${sha256(Buffer.from(manifestContent))}  manifest.json\n`,
      'fortweb-runtime/app/index.html': idxContent,
      'fortweb-runtime/contracts/runtime-requirements.json': rrContent,
    });
    return path.join(zipDir, 'package.zip');
  }

  it('rejects a package whose manifest commit is malformed', async () => {
    const zipPath = await buildLockVariantZip('lock-bad-manifest', (m) => {
      m.fortweb_commit_sha = 'not-a-sha';
    });
    await assert.rejects(
      () => importPackage(zipPath, path.join(nextDir('lock-bad-manifest-dest'), 'payload'), {
        expectedFortwebCommit: 'a'.repeat(40),
      }),
      /fortweb_commit_sha/,
    );
  });

  it('rejects a package whose manifest commit is missing', async () => {
    const zipPath = await buildLockVariantZip('lock-missing-manifest', (m) => {
      delete m.fortweb_commit_sha;
    });
    await assert.rejects(
      () => importPackage(zipPath, path.join(nextDir('lock-missing-dest'), 'payload'), {
        expectedFortwebCommit: 'a'.repeat(40),
      }),
      /fortweb_commit_sha/,
    );
  });

  it('CLI requires --expected-fortweb-commit', () => {
    let caught = null;
    try {
      execFileSync(process.execPath, [IMPORTER_CLI, 'some.zip'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'the CLI must fail when the lock commit is not supplied');
    assert.strictEqual(caught.status, 2);
    assert.match(String(caught.stderr), /--expected-fortweb-commit/);
  });
});

// ── Payload activation atomicity (PR #24 review) ─────────────────────────────
//
// The previous known-good payload must remain recoverable until every
// validation required for acceptance of the new payload has succeeded.

describe('payload activation atomicity', () => {
  it("rejects the reviewer's extra-checksum-line package before it replaces the payload", async () => {
    const workDir = nextDir('atomicity-extra-checksum');
    const destDir = path.join(workDir, 'payload');

    // Establish a known-good active payload through the production importer.
    const good = await makeCanonicalZip(nextDir('atomicity-extra-checksum-good'));
    await importPackage(good.zipPath, destDir);
    const goodHash = sha256(await readFile(path.join(destDir, 'app/index.html')));

    // The candidate is canonical apart from one prohibited extra checksum line.
    const badZip = (
      await makeCanonicalZip(nextDir('atomicity-extra-checksum-bad'), {
        checksumsFor: (digest) => `${digest}  manifest.json\n${'b'.repeat(64)}  app/index.html\n`,
      })
    ).zipPath;

    // The authoritative payload verifier rejects this package, so accepting it
    // would hand the environment a payload that cannot pass its own gate.
    const extractDir = path.join(workDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    execFileSync('unzip', ['-q', badZip, '-d', extractDir], { timeout: 10000 });
    const verifierErrors = await verifyPayload(path.join(extractDir, 'fortweb-runtime'), { apkPrefix: '' });
    assert.ok(
      verifierErrors.some((e) => e.includes('checksums.sha256')),
      `expected the payload verifier to reject the extra checksum line, got: ${JSON.stringify(verifierErrors)}`,
    );

    // The production import path must reject it and leave the prior payload intact.
    await assert.rejects(
      () => importPackage(badZip, destDir),
      /checksums/,
      'a package with extra checksum content must be rejected by the importer',
    );
    assert.strictEqual(
      sha256(await readFile(path.join(destDir, 'app/index.html'))),
      goodHash,
      'the previous payload must be preserved byte-for-byte',
    );
    const parentEntries = await readdir(path.dirname(destDir));
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-candidate')), 'no candidate residue');
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-backup')), 'no backup residue');
  });

  it('rolls back when transactional acceptance validation rejects the activated payload', async () => {
    const workDir = nextDir('atomicity-post-activation');
    const destDir = path.join(workDir, 'payload');

    const good = await makeCanonicalZip(nextDir('atomicity-post-activation-good'));
    await importPackage(good.zipPath, destDir);
    const goodHash = sha256(await readFile(path.join(destDir, 'app/index.html')));

    // Package-level validation accepts this package; only the staged-payload
    // gate rejects it, because raw TypeScript must never ship in the payload.
    // This therefore exercises the real acceptance-validation seam rather than
    // an injected fault.
    const bad = await makeCanonicalZip(nextDir('atomicity-post-activation-bad'), {
      extraPayload: { 'app/raw.ts': 'export const unsupported = 1;\n' },
    });

    await assert.rejects(
      () => importPackage(bad.zipPath, destDir),
      /raw TypeScript/,
      'the staged-payload gate must reject the activated candidate',
    );

    assert.strictEqual(
      sha256(await readFile(path.join(destDir, 'app/index.html'))),
      goodHash,
      'the previous payload must be restored byte-for-byte',
    );
    const parentEntries = await readdir(path.dirname(destDir));
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-candidate')), 'no candidate residue');
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-backup')), 'backup consumed by rollback');
  });

  it('leaves no payload behind when a first install fails acceptance validation', async () => {
    const workDir = nextDir('atomicity-first-install');
    await mkdir(workDir, { recursive: true });
    const destDir = path.join(workDir, 'payload');

    const bad = await makeCanonicalZip(nextDir('atomicity-first-install-bad'), {
      extraPayload: { 'app/raw.ts': 'export const unsupported = 1;\n' },
    });

    await assert.rejects(() => importPackage(bad.zipPath, destDir), /raw TypeScript/);

    assert.ok(!existsSync(destDir), 'a rejected first install must leave no active payload');
    const entries = await readdir(workDir);
    assert.ok(!entries.some((e) => e.startsWith('.payload-candidate')), 'no candidate residue');
    assert.ok(!entries.some((e) => e.startsWith('.payload-backup')), 'no backup residue');
  });

  it('commits the replacement and consumes the backup only after acceptance validation', async () => {
    const workDir = nextDir('atomicity-success');
    const destDir = path.join(workDir, 'payload');

    const first = await makeCanonicalZip(nextDir('atomicity-success-first'));
    await importPackage(first.zipPath, destDir);
    const firstHash = sha256(await readFile(path.join(destDir, 'app/index.html')));

    const second = await makeCanonicalZip(nextDir('atomicity-success-second'));
    const result = await importPackage(second.zipPath, destDir);

    assert.ok(result.includes('staged'), `expected a staged result, got: ${result}`);
    assert.ok(existsSync(path.join(destDir, 'manifest.json')), 'new payload must be active');
    assert.ok(existsSync(path.join(destDir, 'app/app/main.js')), 'new payload entries must be present');
    assert.notStrictEqual(
      sha256(await readFile(path.join(destDir, 'app/index.html'))),
      firstHash,
      'the replacement payload must actually be the new bytes',
    );
    const parentEntries = await readdir(path.dirname(destDir));
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-backup')), 'backup removed after validation');
    assert.ok(!parentEntries.some((e) => e.startsWith('.payload-candidate')), 'candidate removed');
  });
});

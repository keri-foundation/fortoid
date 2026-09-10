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
  validateManifestFiles,
  validateManifestContracts,
  validateChecksums,
  validateRuntimeRequirements,
  activatePayload,
  importPackage,
} from './import-fortweb-runtime-package.mjs';

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
    schema: 'fort.runtime-requirements.v1',
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

async function makeCanonicalZip(dir) {
  const rr = makeRR();
  const rrContent = JSON.stringify(rr);
  const idxContent = `idx-${testSeq}`;
  const manifestContent = JSON.stringify({
    ...makeManifest(),
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ],
  });
  // FortWeb checksums.sha256 contains only the manifest's own digest
  const manifestDigest = sha256(Buffer.from(manifestContent));
  const files = {
    'fortweb-runtime/manifest.json': manifestContent,
    'fortweb-runtime/checksums.sha256': `${manifestDigest}  manifest.json\n`,
    'fortweb-runtime/app/index.html': idxContent,
    'fortweb-runtime/contracts/runtime-requirements.json': rrContent,
  };
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
    const zipDir = nextDir('extra-file');
    const { manifest } = await makeCanonicalZip(nextDir('extra-base'));
    // Add an extra file not in the manifest
    const manifestContent = JSON.stringify(manifest);
    const rrContent = JSON.stringify(makeRR());
    const idxContent = `idx-${testSeq}`;
    const extraFiles = {
      'fortweb-runtime/manifest.json': manifestContent,
      'fortweb-runtime/checksums.sha256': `${sha256(Buffer.from(manifestContent))}  manifest.json\n`,
      'fortweb-runtime/app/index.html': idxContent,
      'fortweb-runtime/contracts/runtime-requirements.json': rrContent,
      'fortweb-runtime/secret.txt': 'not-in-manifest',
    };
    await makeZip(zipDir, extraFiles);
    await assert.rejects(
      () => importPackage(path.join(zipDir, 'package.zip'), path.join(nextDir('extra-dest'), 'payload')),
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

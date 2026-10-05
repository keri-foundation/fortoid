// ── verify-packaged-runtime.test.mjs ───────────────────────────────────────
// Executable negative tests for the FortWeb runtime package verifier.
// Uses programmatic directory and ZIP fixtures.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseChecksums,
  loadManifest,
  verifyPayload,
  verifyApk,
  verifyAab,
  findCaseCollisions,
} from './verify-packaged-runtime.mjs';

// ── helpers ─────────────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(tmpdir(), `fortoid-verify-test-${Date.now()}`);
let _seq = 0;
function seq() { return _seq++; }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function makeManifest(overrides = {}) {
  const s = seq();
  const idxContent = `idx-${s}`;
  const rrContent = `rr-${s}`;
  return {
    schema_version: '1.0.0',
    package_version: '0.0.0',
    package_name: 'fortweb-runtime',
    producer: 'fortweb',
    payload_profile: 'offline-runtime',
    fortweb_commit_sha: 'a'.repeat(40),
    runtime_origin: 'https://appassets.androidplatform.net',
    entrypoint: 'app/index.html',
    contracts: { runtime_requirements: { path: 'contracts/runtime-requirements.json' } },
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ],
    ...overrides,
  };
}

async function stageFixture(label, mfOverrides = {}, extraFiles = {}) {
  const dir = path.join(FIXTURE_DIR, `staged-${seq()}-${label}`);
  const s = seq();

  // Compute file contents first, then build manifest to match
  const fileContents = {};
  fileContents['app/index.html'] = `idx-${s}`;
  fileContents['contracts/runtime-requirements.json'] = `rr-${s}`;

  const mf = makeManifest({
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(fileContents['app/index.html'])), bytes: Buffer.byteLength(fileContents['app/index.html']) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(fileContents['contracts/runtime-requirements.json'])), bytes: Buffer.byteLength(fileContents['contracts/runtime-requirements.json']) },
    ],
    ...mfOverrides,
  });

  const mfRaw = JSON.stringify(mf, null, 2);
  const mfBytes = Buffer.from(mfRaw, 'utf-8');
  const csLine = `${sha256(mfBytes)}  manifest.json\n`;

  const allFiles = {
    'manifest.json': mfRaw,
    'checksums.sha256': csLine,
  };

  // Add files from manifest
  for (const f of mf.files) {
    if (fileContents[f.path]) allFiles[f.path] = fileContents[f.path];
    else allFiles[f.path] = 'x'.repeat(f.bytes);
  }

  // Add extra files
  Object.assign(allFiles, extraFiles);

  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(allFiles)) {
    const fp = path.join(dir, rel);
    await mkdir(path.dirname(fp), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await writeFile(fp, buf);
  }
  return { dir, mf, mfBytes, mfRaw };
}

async function stage(overrides, extras) { return stageFixture('s', overrides, extras); }

// ── ZIP fixture helpers (for APK tests) ─────────────────────────────────────

async function makeZip(dirName, files) {
  const zipDir = path.join(FIXTURE_DIR, `zip-${seq()}-${dirName}`);
  await mkdir(zipDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(zipDir, rel);
    await mkdir(path.dirname(fp), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await writeFile(fp, buf);
  }
  const zipPath = path.join(zipDir, 'test.apk');
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: zipDir, timeout: 10000 });
  return zipPath;
}

async function makeCanonicalApk(label) {
  const s = seq();
  const idxContent = `idx-${s}`;
  const rrContent = `rr-${s}`;

  const mf = makeManifest({
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ],
  });

  const mfRaw = JSON.stringify(mf, null, 2);
  const mfBytes = Buffer.from(mfRaw, 'utf-8');
  const csLine = `${sha256(mfBytes)}  manifest.json\n`;

  const files = {};
  files['assets/payload/manifest.json'] = mfRaw;
  files['assets/payload/checksums.sha256'] = csLine;
  files['assets/payload/app/index.html'] = idxContent;
  files['assets/payload/contracts/runtime-requirements.json'] = rrContent;

  return { zipPath: await makeZip(`canonical-${label}`, files), mf, mfBytes };
}

// Turn a dir fixture into an APK-like ZIP
async function dirAsApk(stagedDir, label) {
  const zipDir = path.join(FIXTURE_DIR, `apk-${seq()}-${label}`);
  await mkdir(path.join(zipDir, 'assets/payload'), { recursive: true });
  // Copy staged fixture into assets/payload
  const stagedFiles = await readdir(stagedDir, { recursive: true, withFileTypes: true });
  for (const ent of stagedFiles) {
    if (!ent.isFile()) continue;
    const src = path.join(ent.parentPath || ent.path, ent.name);
    const rel = path.relative(stagedDir, src);
    const dst = path.join(zipDir, 'assets/payload', rel);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst);
  }
  const zipPath = path.join(zipDir, 'test.apk');
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: zipDir, timeout: 10000 });
  return zipPath;
}

function makeDuplicateApk(stagedDir) {
  // Python's zipfile allows duplicate entries; the `zip` command does not.
  const zipDir = path.join(FIXTURE_DIR, `apk-${seq()}-dup`);
  mkdirSyncRecursive(path.join(zipDir, 'assets/payload'));
  const srcEnts = readdirSync(stagedDir, { recursive: true, withFileTypes: true });
  for (const ent of srcEnts) {
    if (!ent.isFile()) continue;
    const src = path.join(ent.parentPath || ent.path, ent.name);
    const rel = path.relative(stagedDir, src);
    const dst = path.join(zipDir, 'assets/payload', rel);
    mkdirSyncRecursive(path.dirname(dst));
    copyFileSync(src, dst);
  }
  const zipPath = path.join(zipDir, 'test.apk');
  // Use Python to create a ZIP with a duplicate manifest.json entry
  execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
            # Write manifest.json a second time as a duplicate
            if fn == 'manifest.json':
                zf.write(fp, arcname)
`], { timeout: 10000 });
  return zipPath;
}

function mkdirSyncRecursive(p) {
  mkdirSync(p, { recursive: true });
}

// Turn a dir fixture into an AAB-like ZIP (payload under base/assets/payload/)
async function makeCanonicalAab(label) {
  const s = seq();
  const idxContent = `idx-${s}`;
  const rrContent = `rr-${s}`;

  const mf = makeManifest({
    files: [
      { path: 'app/index.html', sha256: sha256(Buffer.from(idxContent)), bytes: Buffer.byteLength(idxContent) },
      { path: 'contracts/runtime-requirements.json', sha256: sha256(Buffer.from(rrContent)), bytes: Buffer.byteLength(rrContent) },
    ],
  });

  const mfRaw = JSON.stringify(mf, null, 2);
  const mfBytes = Buffer.from(mfRaw, 'utf-8');
  const csLine = `${sha256(mfBytes)}  manifest.json\n`;

  const files = {};
  files['base/assets/payload/manifest.json'] = mfRaw;
  files['base/assets/payload/checksums.sha256'] = csLine;
  files['base/assets/payload/app/index.html'] = idxContent;
  files['base/assets/payload/contracts/runtime-requirements.json'] = rrContent;

  return { zipPath: await makeZip(`canonical-aab-${label}`, files), mf, mfBytes };
}

async function dirAsAab(stagedDir, label) {
  const zipDir = path.join(FIXTURE_DIR, `aab-${seq()}-${label}`);
  await mkdir(path.join(zipDir, 'base/assets/payload'), { recursive: true });
  const stagedFiles = await readdir(stagedDir, { recursive: true, withFileTypes: true });
  for (const ent of stagedFiles) {
    if (!ent.isFile()) continue;
    const src = path.join(ent.parentPath || ent.path, ent.name);
    const rel = path.relative(stagedDir, src);
    const dst = path.join(zipDir, 'base/assets/payload', rel);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst);
  }
  const zipPath = path.join(zipDir, 'test.aab');
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: zipDir, timeout: 10000 });
  return zipPath;
}

// ── setup / teardown ────────────────────────────────────────────────────────

before(async () => { await mkdir(FIXTURE_DIR, { recursive: true }); });
after(async () => { await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {}); });

// ═══════════════════════════════════════════════════════════════════════════
// parsers
// ═══════════════════════════════════════════════════════════════════════════

describe('parseChecksums', () => {
  it('parses canonical checksums', () => {
    const buf = Buffer.from('a'.repeat(64) + '  manifest.json\n');
    const r = parseChecksums(buf);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.digest, 'a'.repeat(64));
    assert.strictEqual(r.name, 'manifest.json');
  });

  it('rejects empty file', () => {
    const r = parseChecksums(Buffer.from(''));
    assert.ok(r.errors.some(e => e.includes('empty')));
  });

  it('rejects extra lines', () => {
    const buf = Buffer.from('a'.repeat(64) + '  manifest.json\n' + 'b'.repeat(64) + '  manifest.json\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('2 lines')));
  });

  it('rejects missing double-space separator', () => {
    const buf = Buffer.from('a'.repeat(64) + ' manifest.json\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('malformed')));
  });

  it('rejects short digest', () => {
    const buf = Buffer.from('abc  manifest.json\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('64 hex chars')));
  });

  it('rejects non-hex digest', () => {
    const buf = Buffer.from('z'.repeat(64) + '  manifest.json\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('64 hex chars')));
  });

  it('rejects wrong filename', () => {
    const buf = Buffer.from('a'.repeat(64) + '  other.json\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('expected "manifest.json"')));
  });

  it('rejects invalid UTF-8', () => {
    const buf = Buffer.from([0xFF, 0xFE, 0xFD]);
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('invalid UTF-8')));
  });

  it('rejects U+FFFD in content', () => {
    // Valid UTF-8 bytes that contain literal U+FFFD
    const buf = Buffer.from('a'.repeat(64) + '  manifest.\uFFFDjson\n');
    const r = parseChecksums(buf);
    assert.ok(r.errors.some(e => e.includes('U+FFFD')));
  });
});

describe('loadManifest', () => {
  it('loads valid manifest as raw bytes', async () => {
    const { dir, mfBytes } = await stage();
    const r = await loadManifest(path.join(dir, 'manifest.json'));
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.manifest);
    assert.ok(Buffer.isBuffer(r.rawBytes));
    assert.strictEqual(sha256(r.rawBytes), sha256(mfBytes));
  });

  it('rejects invalid UTF-8', async () => {
    const d = path.join(FIXTURE_DIR, `mf-${seq()}-bad-utf8`);
    await mkdir(d);
    await writeFile(path.join(d, 'manifest.json'), Buffer.from([0xFF, 0xFE, 0xFD]));
    const r = await loadManifest(path.join(d, 'manifest.json'));
    assert.ok(r.errors.some(e => e.includes('invalid UTF-8')));
  });

  it('rejects literal U+FFFD', async () => {
    const d = path.join(FIXTURE_DIR, `mf-${seq()}-fffd`);
    await mkdir(d);
    await writeFile(path.join(d, 'manifest.json'), '{"package_name":"fortweb-runtime","producer":"fortweb",\uFFFD:"bad"}');
    const r = await loadManifest(path.join(d, 'manifest.json'));
    assert.ok(r.errors.some(e => e.includes('U+FFFD')));
  });

  it('rejects malformed JSON', async () => {
    const d = path.join(FIXTURE_DIR, `mf-${seq()}-bad-json`);
    await mkdir(d);
    await writeFile(path.join(d, 'manifest.json'), '{not json');
    const r = await loadManifest(path.join(d, 'manifest.json'));
    assert.ok(r.errors.some(e => e.includes('invalid JSON')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// staged-directory verification
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyPayload (staged)', () => {
  it('1. valid staged payload passes', async () => {
    const { dir } = await stage();
    const e = await verifyPayload(dir);
    assert.deepStrictEqual(e, []);
  });

  it('2. missing manifest fails', async () => {
    const d = path.join(FIXTURE_DIR, `vfy-${seq()}-no-mf`);
    await mkdir(d);
    const e = await verifyPayload(d);
    assert.ok(e.some(m => m.includes('manifest.json not found')));
  });

  it('3. invalid manifest UTF-8 fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'manifest.json'), Buffer.from([0xFF, 0xFE, 0xFD]));
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('invalid UTF-8')));
  });

  it('4. literal U+FFFD in manifest fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'manifest.json'), '{"package_name":"fortweb-runtime","producer":"fortweb",\uFFFD:"bad"}');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('U+FFFD')));
  });

  it('5. malformed manifest JSON fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'manifest.json'), '{not json');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('invalid JSON')));
  });

  it('6. missing checksums fails', async () => {
    const { dir } = await stage();
    await rm(path.join(dir, 'checksums.sha256'));
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('checksums.sha256 not found')));
  });

  it('7. empty checksums fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'checksums.sha256'), '');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('empty')));
  });

  it('8. wrong manifest checksum in checksums fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'checksums.sha256'), '0'.repeat(64) + '  manifest.json\n');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('manifest digest mismatch')));
  });

  it('9. extra checksum line fails', async () => {
    const { dir, mfBytes } = await stage();
    const good = sha256(mfBytes);
    await writeFile(path.join(dir, 'checksums.sha256'), `${good}  manifest.json\n${'b'.repeat(64)}  manifest.json\n`);
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('2 lines')));
  });

  it('10. missing inventory file fails', async () => {
    const { dir } = await stage();
    await rm(path.join(dir, 'app/index.html'));
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('missing manifest file')));
  });

  it('11. unexpected file fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'secret.txt'), 'extra');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('unexpected file')));
  });

  it('12. digest mismatch fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'app/index.html'), 'corrupted!!!');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('digest mismatch')));
  });

  it('13. byte-count mismatch fails', async () => {
    const { dir } = await stage();
    // Write extra bytes
    await writeFile(path.join(dir, 'app/index.html'), 'x'.repeat(999));
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('byte mismatch')));
  });

  it('14. duplicate manifest path fails', async () => {
    const mf = makeManifest();
    mf.files.push({ ...mf.files[0] });
    const { dir } = await stageFixture('dup-mf', mf);
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('duplicate manifest path')));
  });

  it('15. case-colliding manifest paths fail', async () => {
    const mf = makeManifest();
    mf.files.push({ path: 'APP/index.html', sha256: mf.files[0].sha256, bytes: mf.files[0].bytes });
    const { dir, mfBytes } = await stageFixture('case-mf', mf);
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('case-colliding')));
  });

  it('16. stale android-payload-manifest.json fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'android-payload-manifest.json'), 'stale');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('stale artifact')));
  });

  it('17. stale runtime-origin-contract.json fails', async () => {
    const { dir } = await stage();
    await mkdir(path.join(dir, 'fortweb/app'), { recursive: true });
    await writeFile(path.join(dir, 'fortweb/app/runtime-origin-contract.json'), 'stale');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('stale artifact')));
  });

  it('18. staged symlink fails', async () => {
    const { dir } = await stage();
    const linkTarget = path.join(dir, 'app/index.html');
    const linkPath = path.join(dir, 'evil-link');
    await symlink(linkTarget, linkPath);
    // Verify it's actually a symlink
    const st = await lstat(linkPath);
    assert.ok(st.isSymbolicLink(), 'fixture must be a symlink');
    const e = await verifyPayload(dir);
    assert.ok(e.some(m => m.includes('symlink not allowed')));
  });

  it('case-colliding actual files fail (staged)', async () => {
    // Note: case-collision at the filesystem level only works on case-sensitive
    // filesystems (Linux CI, not macOS). The ZIP-based test (24) always works.
    // Verify findCaseCollisions directly.
    const collisions = findCaseCollisions(['app/index.html', 'APP/index.html', 'other.txt']);
    assert.ok(collisions.length > 0, 'findCaseCollisions must detect APP vs app');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// APK verification
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyApk', () => {
  it('19. valid APK passes', async () => {
    const { zipPath } = await makeCanonicalApk('ok');
    const r = await verifyApk(zipPath);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.payloadMembers.length > 0);
  });

  it('20. missing assets/payload/manifest.json fails', async () => {
    // APK with no payload at all
    const zipPath = await makeZip('no-payload', { 'other/file.txt': 'data' });
    await assert.rejects(() => verifyApk(zipPath), /no payload files found/);
  });

  it('21. missing requirements artifact fails', async () => {
    const { dir } = await stage();
    // Remove the file from filesystem but keep in manifest
    await rm(path.join(dir, 'contracts/runtime-requirements.json'));
    const zipPath = await dirAsApk(dir, 'no-rr');
    const r = await verifyApk(zipPath);
    assert.ok(r.errors.some(m => m.includes('missing manifest file')));
  });

  it('22. unexpected APK payload member fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'secret.txt'), 'extra');
    const zipPath = await dirAsApk(dir, 'extra');
    const r = await verifyApk(zipPath);
    assert.ok(r.errors.some(m => m.includes('unexpected file')));
  });

  it('23. duplicate APK member fails before extraction', async () => {
    const { dir } = await stage();
    const zipPath = makeDuplicateApk(dir);
    await assert.rejects(() => verifyApk(zipPath), /duplicate APK member/);
  });

  it('24. case-colliding APK members fail', async () => {
    // Build APK with assets/payload/MANIFEST.JSON and assets/payload/manifest.json
    // Use Python zipfile since macOS zip collapses case-differing names
    const { dir, mfBytes } = await stage();
    const zipDir = path.join(FIXTURE_DIR, `apk-${seq()}-case`);
    await mkdir(path.join(zipDir, 'assets/payload'), { recursive: true });
    // Copy staged files
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const ent of files) {
      if (!ent.isFile()) continue;
      const src = path.join(ent.parentPath || ent.path, ent.name);
      const rel = path.relative(dir, src);
      const dst = path.join(zipDir, 'assets/payload', rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst);
    }
    const zipPath = path.join(zipDir, 'test.apk');
    // Use Python to create ZIP with case-colliding manifest.json entries
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
    # Add a case-colliding copy of manifest.json
    mf_src = os.path.join(root, 'assets/payload/manifest.json')
    zf.write(mf_src, 'assets/payload/MANIFEST.JSON')
`], { timeout: 10000 });
    await assert.rejects(() => verifyApk(zipPath), /case-colliding APK members/);
  });

  it('25. traversal member fails', async () => {
    // Build APK with a traversal path using Python zipfile
    const zipDir = path.join(FIXTURE_DIR, `apk-${seq()}-trav`);
    await mkdir(path.join(zipDir, 'assets/payload'), { recursive: true });
    // Add a valid manifest so the listing finds payload files
    const mfContent = JSON.stringify({ package_name: 'fortweb-runtime', producer: 'fortweb', files: [] });
    await writeFile(path.join(zipDir, 'assets/payload/manifest.json'), mfContent);
    const zipPath = path.join(zipDir, 'test.apk');
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
    # Write a traversal payload member
    zf.writestr('assets/payload/../outside.txt', 'escaped')
`], { timeout: 10000 });
    // Verify the traversal member exists in the ZIP
    const list = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf-8' });
    assert.ok(list.includes('assets/payload/../outside.txt'), 'fixture must contain traversal member');
    await assert.rejects(() => verifyApk(zipPath), /unsafe payload member/);
  });

  it('26. backslash member fails', async () => {
    // Build APK with a backslash path using Python zipfile
    const zipDir = path.join(FIXTURE_DIR, `apk-${seq()}-bs`);
    await mkdir(path.join(zipDir, 'assets/payload'), { recursive: true });
    const mfContent = JSON.stringify({ package_name: 'fortweb-runtime', producer: 'fortweb', files: [] });
    await writeFile(path.join(zipDir, 'assets/payload/manifest.json'), mfContent);
    const zipPath = path.join(zipDir, 'test.apk');
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
    # Write a backslash-bearing payload member
    zf.writestr('assets/payload\\\\evil.txt', 'backslash')
`], { timeout: 10000 });
    // Verify the backslash member exists in the ZIP
    const list = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf-8' });
    assert.ok(list.includes('assets/payload\\evil.txt'), 'fixture must contain backslash member');
    await assert.rejects(() => verifyApk(zipPath), /unsafe payload member/);
  });

  it('27. APK digest mismatch fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'app/index.html'), 'tampered');
    const mf = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'));
    const mfRaw = JSON.stringify(mf, null, 2);
    const mfBytes = Buffer.from(mfRaw, 'utf-8');
    await writeFile(path.join(dir, 'checksums.sha256'), `${sha256(mfBytes)}  manifest.json\n`);
    const zipPath = await dirAsApk(dir, 'digest-bad');
    const r = await verifyApk(zipPath);
    assert.ok(r.errors.some(m => m.includes('digest mismatch')));
  });

  it('28. APK byte-count mismatch fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'app/index.html'), 'x'.repeat(9999));
    const mf = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'));
    const mfRaw = JSON.stringify(mf, null, 2);
    const mfBytes = Buffer.from(mfRaw, 'utf-8');
    await writeFile(path.join(dir, 'checksums.sha256'), `${sha256(mfBytes)}  manifest.json\n`);
    const zipPath = await dirAsApk(dir, 'bytes-bad');
    const r = await verifyApk(zipPath);
    assert.ok(r.errors.some(m => m.includes('byte mismatch')));
  });

  it('29. stale nested payload/fortweb subtree fails', async () => {
    const { dir } = await stage();
    await mkdir(path.join(dir, 'fortweb'), { recursive: true });
    await writeFile(path.join(dir, 'fortweb/stale.txt'), 'stale');
    const zipPath = await dirAsApk(dir, 'nested');
    const r = await verifyApk(zipPath);
    assert.ok(r.errors.some(m => m.includes('stale nested')));
  });

  it('30. no assets/payload subtree fails', async () => {
    const zipPath = await makeZip('no-sub', { 'not-payload/x.txt': 'x' });
    await assert.rejects(() => verifyApk(zipPath), /no payload files found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AAB verification
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyAab', () => {
  it('31. valid AAB passes', async () => {
    const { zipPath } = await makeCanonicalAab('ok');
    const r = await verifyAab(zipPath);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.payloadMembers.length > 0);
  });

  it('32. no base/assets/payload subtree fails', async () => {
    const zipPath = await makeZip('aab-no-sub', { 'other/file.txt': 'data' });
    await assert.rejects(() => verifyAab(zipPath), /no payload files found in AAB/);
  });

  it('33. AAB missing producer file fails', async () => {
    const { dir } = await stage();
    await rm(path.join(dir, 'contracts/runtime-requirements.json'));
    const zipPath = await dirAsAab(dir, 'no-rr');
    const r = await verifyAab(zipPath);
    assert.ok(r.errors.some(m => m.includes('missing manifest file')));
  });

  it('34. AAB unexpected payload member fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'secret.txt'), 'extra');
    const zipPath = await dirAsAab(dir, 'extra');
    const r = await verifyAab(zipPath);
    assert.ok(r.errors.some(m => m.includes('unexpected file')));
  });

  it('35. AAB digest mismatch fails', async () => {
    const { dir } = await stage();
    await writeFile(path.join(dir, 'app/index.html'), 'tampered');
    const mf = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8'));
    const mfRaw = JSON.stringify(mf, null, 2);
    const mfBytes = Buffer.from(mfRaw, 'utf-8');
    await writeFile(path.join(dir, 'checksums.sha256'), `${sha256(mfBytes)}  manifest.json\n`);
    const zipPath = await dirAsAab(dir, 'digest-bad');
    const r = await verifyAab(zipPath);
    assert.ok(r.errors.some(m => m.includes('digest mismatch')));
  });

  it('36. AAB traversal member fails before extraction', async () => {
    const zipDir = path.join(FIXTURE_DIR, `aab-${seq()}-trav`);
    await mkdir(path.join(zipDir, 'base/assets/payload'), { recursive: true });
    const mfContent = JSON.stringify({ package_name: 'fortweb-runtime', producer: 'fortweb', files: [] });
    await writeFile(path.join(zipDir, 'base/assets/payload/manifest.json'), mfContent);
    const zipPath = path.join(zipDir, 'test.aab');
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
    zf.writestr('base/assets/payload/../outside.txt', 'escaped')
`], { timeout: 10000 });
    await assert.rejects(() => verifyAab(zipPath), /unsafe payload member/);
  });

  it('37. AAB duplicate member fails before extraction', async () => {
    const { dir } = await stage();
    const zipDir = path.join(FIXTURE_DIR, `aab-${seq()}-dup`);
    mkdirSyncRecursive(path.join(zipDir, 'base/assets/payload'));
    const srcEnts = readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const ent of srcEnts) {
      if (!ent.isFile()) continue;
      const src = path.join(ent.parentPath || ent.path, ent.name);
      const rel = path.relative(dir, src);
      const dst = path.join(zipDir, 'base/assets/payload', rel);
      mkdirSyncRecursive(path.dirname(dst));
      copyFileSync(src, dst);
    }
    const zipPath = path.join(zipDir, 'test.aab');
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
            if fn == 'manifest.json':
                zf.write(fp, arcname)
`], { timeout: 10000 });
    await assert.rejects(() => verifyAab(zipPath), /duplicate AAB member/);
  });

  it('38. AAB case-colliding members fail', async () => {
    const { dir } = await stage();
    const zipDir = path.join(FIXTURE_DIR, `aab-${seq()}-case`);
    await mkdir(path.join(zipDir, 'base/assets/payload'), { recursive: true });
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const ent of files) {
      if (!ent.isFile()) continue;
      const src = path.join(ent.parentPath || ent.path, ent.name);
      const rel = path.relative(dir, src);
      const dst = path.join(zipDir, 'base/assets/payload', rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst);
    }
    const zipPath = path.join(zipDir, 'test.aab');
    execFileSync('python3', ['-c', `
import zipfile, os
zp = '${zipPath}'
root = '${zipDir}'
with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            arcname = os.path.relpath(fp, root)
            zf.write(fp, arcname)
    mf_src = os.path.join(root, 'base/assets/payload/manifest.json')
    zf.write(mf_src, 'base/assets/payload/MANIFEST.JSON')
`], { timeout: 10000 });
    await assert.rejects(() => verifyAab(zipPath), /case-colliding AAB members/);
  });
});

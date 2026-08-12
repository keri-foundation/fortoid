#!/usr/bin/env node

/**
 * Verify a FortWeb runtime payload — staged directory or APK contents.
 *
 * Usage:
 *   node tools/verify-packaged-runtime.mjs <payload-dir>
 *   node tools/verify-packaged-runtime.mjs --apk <path-to-apk>
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat, rm, mkdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const MANIFEST_FILENAME = 'manifest.json';
const CHECKSUM_FILENAME = 'checksums.sha256';
const STALE_ANDROID_MANIFEST = 'android-payload-manifest.json';
const STALE_ORIGIN_CONTRACT = 'fortweb/app/runtime-origin-contract.json';
const CS_DIGEST_RE = /^[0-9a-f]{64}$/;

export class VerifyError extends Error {
  constructor(msg) { super(msg); this.name = 'VerifyError'; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(fp);
    stream.on('error', reject);
    stream.on('data', c => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Buf(buf) { return createHash('sha256').update(buf).digest('hex'); }

function relativePath(p) { return p.replace(/\\/g, '/'); }

function isSafeRelative(p) {
  if (p === '' || path.isAbsolute(p) || p.includes('\\')) return false;
  const n = path.normalize(p);
  return n === p && !n.startsWith('..') && !n.split(path.sep).includes('..');
}

/** Case-insensitive duplicate detection. */
export function findCaseCollisions(paths) {
  const lower = new Map(), collisions = [];
  for (const p of paths) {
    const key = p.toLowerCase();
    if (lower.has(key) && lower.get(key) !== p) collisions.push([lower.get(key), p]);
    else lower.set(key, p);
  }
  return collisions;
}

// ── checksums.sha256 — strict canonical parser ─────────────────────────────

/**
 * Parse checksums.sha256.
 * FortWeb canonical format: exactly one line:
 *   <64 lowercase hex><two spaces>manifest.json
 * Rejects empty, extra lines, malformed digest, wrong filename, missing separator.
 */
export function parseChecksums(rawBytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes); }
  catch (e) { return { errors: [`checksums.sha256: invalid UTF-8: ${e.message}`] }; }

  if (text.includes('\uFFFD')) return { errors: ['checksums.sha256: contains U+FFFD replacement characters'] };

  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return { errors: ['checksums.sha256: empty'] };
  if (lines.length > 1) return { errors: [`checksums.sha256: expected 1 entry, got ${lines.length} lines`] };

  const line = lines[0];
  // Must be: digest  manifest.json (two spaces)
  const idx = line.indexOf('  ');
  if (idx === -1) return { errors: ['checksums.sha256: malformed — expected "<digest>  manifest.json"'] };

  const digest = line.slice(0, idx);
  const name = line.slice(idx + 2);

  const errors = [];
  if (digest.length !== 64 || !CS_DIGEST_RE.test(digest))
    errors.push(`checksums.sha256: digest must be 64 hex chars, got "${digest.slice(0, 64)}"`);
  if (name !== MANIFEST_FILENAME)
    errors.push(`checksums.sha256: expected "manifest.json", got "${name}"`);
  return { digest, name, raw: text, errors };
}

// ── manifest — raw-byte integrity ──────────────────────────────────────────

/**
 * Read manifest.json as raw bytes, validate, hash, decode.
 * Returns { manifest, rawBytes, errors }.
 */
export async function loadManifest(mfPath) {
  const errors = [];
  let rawBytes;
  try { rawBytes = await readFile(mfPath); }
  catch (e) { return { errors: [`manifest.json: cannot read: ${e.message}`] }; }

  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes); }
  catch (e) { return { errors: [`manifest.json: invalid UTF-8: ${e.message}`] }; }

  if (text.includes('\uFFFD')) return { errors: ['manifest.json: contains U+FFFD replacement characters'] };

  let manifest;
  try { manifest = JSON.parse(text); }
  catch (e) { return { errors: [`manifest.json: invalid JSON: ${e.message}`] }; }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return { errors: ['manifest.json: must be a JSON object'] };

  return { manifest, rawBytes, text, errors };
}

// ── staged-directory verification ──────────────────────────────────────────

export async function verifyPayload(rootDir, opts = {}) {
  const prefix = opts.apkPrefix || '';
  const errors = [];

  // 1. manifest.json — raw-byte integrity
  const mfRel = prefix + MANIFEST_FILENAME;
  const mfPath = path.join(rootDir, mfRel);
  if (!existsSync(mfPath)) return [`${MANIFEST_FILENAME} not found at ${mfRel}`];

  const { manifest, rawBytes: mfBytes, errors: mfErrs } = await loadManifest(mfPath);
  if (mfErrs.length) return mfErrs;

  if (!manifest.package_name || manifest.package_name !== 'fortweb-runtime')
    errors.push(`manifest: expected package_name "fortweb-runtime", got "${manifest.package_name || '(missing)'}"`);
  if (!manifest.producer || manifest.producer !== 'fortweb')
    errors.push('manifest: expected producer "fortweb"');
  if (!Array.isArray(manifest.files)) {
    errors.push('manifest.files: must be an array');
    return errors;
  }
  if (manifest.files.length === 0)
    errors.push('manifest.files: must not be empty');

  // 2. checksums.sha256 — strict canonical, against raw manifest bytes
  const csRel = prefix + CHECKSUM_FILENAME;
  const csPath = path.join(rootDir, csRel);
  if (!existsSync(csPath)) { errors.push(`${CHECKSUM_FILENAME} not found`); }
  else {
    let csBytes;
    try { csBytes = await readFile(csPath); }
    catch (e) { errors.push(`checksums.sha256: cannot read: ${e.message}`); }

    if (csBytes) {
      const cs = parseChecksums(csBytes);
      if (cs.errors.length) errors.push(...cs.errors);
      else {
        // Hash actual raw manifest bytes, not decoded/re-encoded text
        const actualManifestDigest = sha256Buf(mfBytes);
        if (cs.digest !== actualManifestDigest)
          errors.push(`checksums.sha256: manifest digest mismatch (expected ${cs.digest}, actual ${actualManifestDigest})`);
      }
    }
  }

  // 3. Build permitted path set with case-collision detection
  const allDeclared = [prefix + MANIFEST_FILENAME, prefix + CHECKSUM_FILENAME];
  const manifestEntries = new Map();
  const seenPaths = new Set();
  for (const f of manifest.files) {
    const fp = prefix + f.path;
    allDeclared.push(fp);
    if (seenPaths.has(fp)) { errors.push(`duplicate manifest path: ${f.path}`); continue; }
    seenPaths.add(fp);
    manifestEntries.set(fp, f);
  }

  // Case-collision among declared paths
  const declaredCollisions = findCaseCollisions(allDeclared);
  for (const [a, b] of declaredCollisions)
    errors.push(`case-colliding paths: "${a}" vs "${b}"`);

  const permitted = new Set(allDeclared);

  // 4. Inventory actual filesystem entries
  const actualPaths = new Map();
  if (!existsSync(rootDir)) return [`payload root not found: ${rootDir}`];

  const allEnts = await readdir(rootDir, { recursive: true, withFileTypes: true });
  for (const ent of allEnts) {
    const abs = path.join(ent.parentPath || ent.path, ent.name);
    const rel = relativePath(path.relative(rootDir, abs));

    // Symlink check BEFORE isFile() skip
    if (ent.isSymbolicLink()) { errors.push(`symlink not allowed: ${rel}`); continue; }
    if (!ent.isFile()) continue; // directories are structural

    if (actualPaths.has(rel)) errors.push(`duplicate file in payload: ${rel}`);
    actualPaths.set(rel, abs);
  }

  // Case-collision among actual files
  const actualCollisions = findCaseCollisions([...actualPaths.keys()]);
  for (const [a, b] of actualCollisions)
    errors.push(`case-colliding files: "${a}" vs "${b}"`);

  // 5. Check every manifest entry exists and matches
  for (const [rel, entry] of manifestEntries) {
    const abs = actualPaths.get(rel);
    if (!abs) { errors.push(`missing manifest file: ${rel}`); continue; }
    try {
      const ad = await sha256File(abs);
      if (ad !== entry.sha256) errors.push(`digest mismatch: ${rel}`);
      const st = await lstat(abs);
      if (st.size !== entry.bytes) errors.push(`byte mismatch: ${rel}: manifest=${entry.bytes} actual=${st.size}`);
    } catch (e) { errors.push(`error reading ${rel}: ${e.message}`); }
  }

  // Verify metadata files present
  for (const meta of [prefix + MANIFEST_FILENAME, prefix + CHECKSUM_FILENAME]) {
    if (!actualPaths.has(meta) && !errors.some(e => e.includes(meta)))
      errors.push(`missing: ${meta}`);
  }

  // 6. Reject unexpected files
  for (const rel of actualPaths.keys()) {
    if (!permitted.has(rel)) errors.push(`unexpected file: ${rel}`);
  }

  // 7. Stale artifacts
  for (const stale of [prefix + STALE_ANDROID_MANIFEST, prefix + STALE_ORIGIN_CONTRACT]) {
    if (actualPaths.has(stale)) errors.push(`stale artifact present: ${stale}`);
  }

  return errors;
}

// ── Android archive mode — machine-readable listing, pre-extraction validation ─

const APK_PAYLOAD_PREFIX = 'assets/payload/';
const AAB_PAYLOAD_PREFIX = 'base/assets/payload/';

/** List archive members using unzip -Z -1 (machine-readable). */
function unzipListMachine(archivePath) {
  try {
    const out = execFileSync('unzip', ['-Z', '-1', archivePath], {
      encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    throw new VerifyError(`unzip -Z -1 failed: ${e.stderr || e.message}`);
  }
}

/** Extract specific members from an archive. */
function unzipExtractMembers(archivePath, members, destDir) {
  try {
    execFileSync('unzip', ['-q', '-o', archivePath, ...members, '-d', destDir], {
      timeout: 30000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    throw new VerifyError(`unzip extract failed: ${e.stderr || e.message}`);
  }
}

/**
 * Verify a ZIP-based Android package (APK or AAB) carries an exact copy of the
 * canonical FortWeb payload under the given archive member prefix.
 */
async function verifyAndroidArchive(archivePath, payloadPrefix, artifactKind) {
  if (!existsSync(archivePath)) throw new VerifyError(`${artifactKind} not found: ${archivePath}`);

  // Machine-readable member listing
  const allMembers = unzipListMachine(archivePath);

  // Reject unsafe members immediately — before prefix filtering
  const memberErrs = [];
  for (const m of allMembers) {
    if (!isSafeRelative(m)) memberErrs.push(`unsafe payload member: ${m}`);
  }
  if (memberErrs.length) throw new VerifyError(`${artifactKind} member validation:\n  - ${memberErrs.join('\n  - ')}`);

  // Filter to payload members (not directory entries)
  const payloadMembers = allMembers.filter(m => m.startsWith(payloadPrefix) && !m.endsWith('/'));
  if (payloadMembers.length === 0)
    throw new VerifyError(`no payload files found in ${artifactKind} under ${payloadPrefix}`);

  // Validate member paths before extraction
  const memErrs = [];
  for (const m of payloadMembers) {
    const rel = m.slice(payloadPrefix.length);
    if (!isSafeRelative(rel)) memErrs.push(`unsafe payload member: ${m}`);
  }
  // Duplicate detection
  const seenMems = new Set();
  for (const m of payloadMembers) {
    if (seenMems.has(m)) memErrs.push(`duplicate ${artifactKind} member: ${m}`);
    seenMems.add(m);
  }
  // Case-collision detection
  const memCollisions = findCaseCollisions(payloadMembers);
  for (const [a, b] of memCollisions)
    memErrs.push(`case-colliding ${artifactKind} members: "${a}" vs "${b}"`);

  if (memErrs.length) throw new VerifyError(`${artifactKind} member validation:\n  - ${memErrs.join('\n  - ')}`);

  // Require manifest.json exists in payload
  if (!payloadMembers.includes(payloadPrefix + MANIFEST_FILENAME))
    throw new VerifyError(`${payloadPrefix}${MANIFEST_FILENAME} not found in ${artifactKind}`);

  const tmpDir = path.join(tmpdir(), `${artifactKind.toLowerCase()}-verify-${Date.now()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    unzipExtractMembers(archivePath, payloadMembers, tmpDir);

    const errors = await verifyPayload(tmpDir, { apkPrefix: payloadPrefix });

    // Check for stale nested fortweb structure
    const staleNested = path.join(tmpDir, payloadPrefix + 'fortweb');
    if (existsSync(staleNested)) {
      errors.push('stale nested payload/fortweb/ subtree present');
    }

    return { errors, payloadMembers };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function verifyApk(apkPath) {
  return verifyAndroidArchive(apkPath, APK_PAYLOAD_PREFIX, 'APK');
}

export async function verifyAab(aabPath) {
  return verifyAndroidArchive(aabPath, AAB_PAYLOAD_PREFIX, 'AAB');
}

// ── CLI boundary (process.exit only here) ──────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let result;

  if (args[0] === '--apk') {
    const apkPath = args[1];
    if (!apkPath) { console.error('usage: node tools/verify-packaged-runtime.mjs --apk <apk>'); process.exit(2); }
    result = await verifyApk(apkPath);
  } else if (args[0] === '--aab') {
    const aabPath = args[1];
    if (!aabPath) { console.error('usage: node tools/verify-packaged-runtime.mjs --aab <aab>'); process.exit(2); }
    result = await verifyAab(aabPath);
  } else {
    const dirPath = args[0];
    if (!dirPath) { console.error('usage: node tools/verify-packaged-runtime.mjs <dir>'); process.exit(2); }
    result = { errors: await verifyPayload(dirPath, { apkPrefix: '' }) };
  }

  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`[verify-packaged-runtime] ${e}`);
    process.exit(1);
  }
  const count = result.payloadMembers ? result.payloadMembers.length : 'staged';
  console.error(`[verify-packaged-runtime] PASS: ${count} files verified`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main();
}

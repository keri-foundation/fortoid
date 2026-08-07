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
import { readFile, readdir, lstat, rm } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILENAME = 'manifest.json';
const CHECKSUM_FILENAME = 'checksums.sha256';
const APK_PAYLOAD_PREFIX = 'assets/payload/';
const STALE_ANDROID_MANIFEST = 'android-payload-manifest.json';
const STALE_ORIGIN_CONTRACT = 'fortweb/app/runtime-origin-contract.json';

class VerifyError extends Error {
  constructor(msg) { super(msg); this.name = 'VerifyError'; }
}

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

export async function verifyPayload(rootDir, opts = {}) {
  const prefix = opts.apkPrefix || '';
  const errors = [];

  // 1. manifest.json
  const mfRel = prefix + MANIFEST_FILENAME;
  const mfPath = path.join(rootDir, mfRel);
  if (!existsSync(mfPath)) return [`${MANIFEST_FILENAME} not found at ${mfRel}`];

  let manifest, manifestRaw;
  try {
    manifestRaw = await readFile(mfPath, 'utf-8');
    manifest = JSON.parse(manifestRaw);
  } catch (e) { return [`${MANIFEST_FILENAME}: ${e.message}`]; }

  if (!manifest.package_name || manifest.package_name !== 'fortweb-runtime') {
    errors.push(`manifest: expected package_name "fortweb-runtime", got "${manifest.package_name || '(missing)'}"`);
  }
  if (!manifest.producer || manifest.producer !== 'fortweb') {
    errors.push(`manifest: expected producer "fortweb"`);
  }
  if (!Array.isArray(manifest.files)) {
    errors.push('manifest.files: must be an array');
    return errors;
  }

  // 2. checksums.sha256 self-check
  const csRel = prefix + CHECKSUM_FILENAME;
  const csPath = path.join(rootDir, csRel);
  if (!existsSync(csPath)) { errors.push(`${CHECKSUM_FILENAME} not found`); }
  else {
    try {
      const csRaw = (await readFile(csPath, 'utf-8')).trim();
      const parts = csRaw.split(/\s+/, 2);
      if (parts.length !== 2) errors.push('checksums.sha256: malformed');
      else {
        const [digest, name] = parts;
        if (name !== MANIFEST_FILENAME) errors.push(`checksums.sha256: expected "manifest.json", got "${name}"`);
        const actual = sha256Buf(Buffer.from(manifestRaw));
        if (digest !== actual) errors.push(`checksums.sha256: manifest digest mismatch`);
      }
    } catch (e) { errors.push(`checksums.sha256: ${e.message}`); }
  }

  // 3. Build permitted path set
  const permitted = new Set();
  permitted.add(prefix + MANIFEST_FILENAME);
  permitted.add(prefix + CHECKSUM_FILENAME);
  const manifestEntries = new Map();
  for (const f of manifest.files) {
    const fp = prefix + f.path;
    if (permitted.has(fp)) errors.push(`duplicate manifest path: ${f.path}`);
    if (manifestEntries.has(fp)) errors.push(`duplicate manifest path: ${f.path}`);
    permitted.add(fp);
    manifestEntries.set(fp, f);
  }

  // 4. Inventory the actual files
  const actualPaths = new Map();
  if (!existsSync(rootDir)) return [`payload root not found: ${rootDir}`];
  const allEnts = await readdir(rootDir, { recursive: true, withFileTypes: true });
  for (const ent of allEnts) {
    if (!ent.isFile()) continue;
    const abs = path.join(ent.parentPath || ent.path, ent.name);
    const rel = relativePath(path.relative(rootDir, abs));
    if (actualPaths.has(rel)) errors.push(`duplicate file in payload: ${rel}`);
    actualPaths.set(rel, abs);
  }

  // 5. Check every permitted path exists and matches
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

  // Also verify manifest and checksums are present
  for (const meta of [prefix + MANIFEST_FILENAME, prefix + CHECKSUM_FILENAME]) {
    if (!actualPaths.has(meta) && !errors.some(e => e.includes(meta))) {
      errors.push(`missing: ${meta}`);
    }
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

// ── APK mode ────────────────────────────────────────────────────────────────

async function verifyApk(apkPath) {
  if (!existsSync(apkPath)) throw new VerifyError(`APK not found: ${apkPath}`);

  const tmpDir = path.join(tmpdir(), `apk-verify-${Date.now()}`);
  try {
    // List payload files
    let listing;
    try {
      listing = execFileSync('unzip', ['-l', apkPath], { encoding: 'utf-8', timeout: 15000 });
    } catch (e) { throw new VerifyError(`unzip -l failed: ${e.stderr || e.message}`); }

    const payloadFiles = listing.split('\n')
      .filter(l => l.includes(APK_PAYLOAD_PREFIX))
      .map(l => l.trim().split(/\s+/).pop())
      .filter(Boolean);

    if (payloadFiles.length === 0) throw new VerifyError(`no payload files found in APK under ${APK_PAYLOAD_PREFIX}`);

    // Extract payload to temp
    execFileSync('unzip', ['-q', '-o', apkPath, ...payloadFiles, '-d', tmpDir], { timeout: 30000 });

    // Verify uses the tmpDir root with APK prefix
    const rootDir = tmpDir;
    const errors = await verifyPayload(rootDir, { apkPrefix: APK_PAYLOAD_PREFIX });

    // Also check for stale nested fortweb structure
    const staleNested = path.join(tmpDir, APK_PAYLOAD_PREFIX + 'fortweb');
    if (existsSync(staleNested)) {
      errors.push('stale nested payload/fortweb/ subtree present');
    }

    return { errors, payloadFiles };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let result;

  if (args[0] === '--apk') {
    const apkPath = args[1];
    if (!apkPath) { console.error('usage: node tools/verify-packaged-runtime.mjs --apk <apk>'); process.exit(2); }
    result = await verifyApk(apkPath);
  } else {
    const dirPath = args[0];
    if (!dirPath) { console.error('usage: node tools/verify-packaged-runtime.mjs <dir>'); process.exit(2); }
    result = { errors: await verifyPayload(dirPath, { apkPrefix: '' }) };
  }

  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`[verify-packaged-runtime] ${e}`);
    process.exit(1);
  }
  const count = result.payloadFiles ? result.payloadFiles.length : 'staged';
  console.error(`[verify-packaged-runtime] PASS: ${count} files verified`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main();
}

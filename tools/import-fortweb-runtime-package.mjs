#!/usr/bin/env node

/**
 * Byte-preserving FortWeb runtime package importer for Android.
 *
 * Accepts one FortWeb runtime ZIP (produced by FortWeb's tools/package-runtime.mjs),
 * validates archive structure and integrity against the producer manifest, and
 * transactionally activates the verified package under app/src/main/assets/payload/.
 *
 * The importer never modifies a single producer byte. The producer manifest
 * (`manifest.json`) and checksum file (`checksums.sha256`) are the authoritative
 * inventory.
 *
 * Usage:
 *   node tools/import-fortweb-runtime-package.mjs <runtime-package.zip>
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, rename, lstat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DEST = path.join(REPO_ROOT, 'app/src/main/assets/payload');
const EXPECTED_PACKAGE_NAME = 'fortweb-runtime';
const EXPECTED_PRODUCER = 'fortweb';
const EXPECTED_PROFILE = 'offline-runtime';
const EXPECTED_RR_PATH = 'contracts/runtime-requirements.json';
const MANIFEST_FILENAME = 'manifest.json';
const CHECKSUM_FILENAME = 'checksums.sha256';

// ── Error type ───────────────────────────────────────────────────────────────

class ImportError extends Error {
  constructor(msg) { super(msg); this.name = 'ImportError'; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isSafeRelative(p) {
  if (p === '') return false;
  if (path.isAbsolute(p)) return false;
  if (p.includes('\\')) return false;
  const normalized = path.normalize(p);
  if (normalized !== p) return false;
  if (normalized.startsWith('..')) return false;
  return !normalized.split(path.sep).includes('..');
}

// ── ZIP operations (argument-safe, no shell interpolation) ──────────────────

function unzipList(zipPath) {
  try {
    const out = execFileSync('unzip', ['-Z', '-1', zipPath], {
      encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    throw new ImportError(`unzip list failed: ${e.stderr || e.message}`);
  }
}

function unzipExtract(zipPath, destDir) {
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], {
      timeout: 30000, maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    throw new ImportError(`unzip extract failed: ${e.stderr || e.message}`);
  }
}

// ── Entry safety ────────────────────────────────────────────────────────────

export function validateEntries(entries) {
  const errors = [];
  const seen = new Set();
  for (const raw of entries) {
    const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!trimmed) continue;
    if (!isSafeRelative(trimmed)) { errors.push(`unsafe path: ${raw}`); continue; }
    if (seen.has(trimmed)) { errors.push(`duplicate entry: ${trimmed}`); }
    seen.add(trimmed);
  }
  return errors;
}

// ── Manifest validation ─────────────────────────────────────────────────────

export function validateManifestIdentity(manifest) {
  const e = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return ['manifest.json: must be a JSON object'];
  if (manifest.package_name !== EXPECTED_PACKAGE_NAME)
    e.push(`manifest.json: expected package_name "${EXPECTED_PACKAGE_NAME}", got "${manifest.package_name || '(missing)'}"`);
  if (manifest.producer !== EXPECTED_PRODUCER)
    e.push(`manifest.json: expected producer "${EXPECTED_PRODUCER}", got "${manifest.producer || '(missing)'}"`);
  if (manifest.payload_profile !== EXPECTED_PROFILE)
    e.push(`manifest.json: expected payload_profile "${EXPECTED_PROFILE}", got "${manifest.payload_profile || '(missing)'}"`);
  if (!manifest.schema_version || typeof manifest.schema_version !== 'string')
    e.push('manifest.json: missing or invalid schema_version');
  if (!manifest.entrypoint || typeof manifest.entrypoint !== 'string')
    e.push('manifest.json: missing entrypoint');
  return e;
}

export function validateManifestFiles(manifest) {
  const files = manifest.files;
  if (!Array.isArray(files)) return ['manifest.files: must be an array'];
  const errors = [], seen = new Set();
  for (let i = 0; i < files.length; i++) {
    const entry = files[i], pf = `manifest.files[${i}]`;
    if (!entry || typeof entry !== 'object') { errors.push(`${pf}: must be an object`); continue; }
    if (typeof entry.path !== 'string' || entry.path.length === 0)
      errors.push(`${pf}: missing or empty path`);
    else if (!isSafeRelative(entry.path))
      errors.push(`${pf}: unsafe path "${entry.path}"`);
    else if (seen.has(entry.path))
      errors.push(`${pf}: duplicate path "${entry.path}"`);
    else seen.add(entry.path);
    if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(entry.sha256))
      errors.push(`${pf}: sha256 must be a 64-char hex string`);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0)
      errors.push(`${pf}: bytes must be a non-negative integer`);
  }
  return errors;
}

export function validateManifestContracts(manifest) {
  const e = [];
  if (!manifest.contracts || typeof manifest.contracts !== 'object' || Array.isArray(manifest.contracts))
    return ['manifest.contracts: missing or not an object'];
  const rr = manifest.contracts.runtime_requirements;
  if (!rr || typeof rr !== 'object') return ['manifest.contracts.runtime_requirements: missing'];
  if (typeof rr.path !== 'string' || rr.path.length === 0)
    e.push('manifest.contracts.runtime_requirements.path: missing or empty');
  else if (rr.path !== EXPECTED_RR_PATH)
    e.push(`manifest.contracts.runtime_requirements.path: expected "${EXPECTED_RR_PATH}", got "${rr.path}"`);
  return e;
}

// ── Checksum validation ─────────────────────────────────────────────────────

/**
 * FortWeb's checksums.sha256 contains one entry: the manifest's own SHA-256.
 * It is a self-check — the manifest.files[] array has per-file digests.
 */
export async function validateChecksums(checksumsPath, extractedDir, manifest) {
  const errors = [];

  // 1. Verify checksums.sha256 matches the actual manifest file
  const manifestPath = path.join(extractedDir, MANIFEST_FILENAME);
  let manifestDigest;
  try { manifestDigest = await sha256File(manifestPath); }
  catch (e) { return [`checksums.sha256: cannot hash manifest: ${e.message}`]; }

  let raw;
  try { raw = await readFile(checksumsPath, 'utf-8'); }
  catch (e) { return [`checksums.sha256: cannot read: ${e.message}`]; }

  const trimmed = raw.trim();
  if (!trimmed) return ['checksums.sha256: empty'];

  const parts = trimmed.split(/\s+/, 2);
  if (parts.length !== 2) return [`checksums.sha256: malformed: "${trimmed.slice(0, 80)}"`];
  const [digest, pathName] = parts;
  if (pathName !== MANIFEST_FILENAME) {
    errors.push(`checksums.sha256: expected path "${MANIFEST_FILENAME}", got "${pathName}"`);
  }
  if (digest !== manifestDigest) {
    errors.push(`checksums.sha256: manifest digest mismatch: expected ${digest}, actual ${manifestDigest}`);
  }

  // 2. Verify every file in manifest.files against actual extracted bytes
  const files = manifest?.files;
  if (!Array.isArray(files)) return errors;

  for (const entry of files) {
    const { path: rp, sha256: md, bytes } = entry;
    const fp = path.join(extractedDir, rp);
    if (!existsSync(fp)) { errors.push(`manifest file not found: ${rp}`); continue; }
    try {
      const ad = await sha256File(fp);
      if (ad !== md) errors.push(`digest mismatch for ${rp}: manifest=${md}, actual=${ad}`);
      const st = await lstat(fp);
      if (st.size !== bytes) errors.push(`byte count mismatch for ${rp}: manifest=${bytes}, actual=${st.size}`);
    } catch (er) { errors.push(`error verifying ${rp}: ${er.message}`); }
  }
  return errors;
}

// ── Runtime requirements validation ─────────────────────────────────────────

export async function validateRuntimeRequirements(extractedDir, manifest) {
  const rrp = manifest?.contracts?.runtime_requirements?.path;
  if (!rrp) return ['manifest.contracts.runtime_requirements.path: missing'];
  const fp = path.join(extractedDir, rrp);
  if (!existsSync(fp)) return [`runtime requirements file not found: ${rrp}`];

  let raw;
  try {
    const buf = await readFile(fp);
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) { return [`runtime requirements: invalid UTF-8: ${e.message}`]; }
  if (raw.includes('\uFFFD')) return ['runtime requirements: contains U+FFFD replacement characters'];

  let rr;
  try { rr = JSON.parse(raw); }
  catch (e) { return [`runtime requirements: invalid JSON: ${e.message}`]; }

  const e = [];
  if (!rr.schema || typeof rr.schema !== 'string') e.push('runtime requirements: missing schema');
  if (!rr.producer || rr.producer !== manifest.producer)
    e.push(`runtime requirements: producer mismatch (expected "${manifest.producer}", got "${rr.producer || '(missing)'}")`);
  if (!rr.payload_profile || rr.payload_profile !== manifest.payload_profile)
    e.push('runtime requirements: payload_profile mismatch');
  return e;
}

// ── Transactional activation ────────────────────────────────────────────────

export async function activatePayload(extractedDir, destDir, packageName, opts = {}) {
  const parent = path.dirname(destDir);
  const candidateDir = path.join(parent, '.payload-candidate');
  const backupDir = path.join(parent, '.payload-backup');

  await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
  await rm(backupDir, { recursive: true, force: true }).catch(() => {});

  const pkgDir = path.join(extractedDir, packageName);
  const sourceDir = existsSync(pkgDir) ? pkgDir : extractedDir;

  try {
    // Copy to candidate
    await mkdir(candidateDir, { recursive: true });
    const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const src = path.join(ent.parentPath || ent.path, ent.name);
      const rel = path.relative(sourceDir, src);
      const dst = path.join(candidateDir, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst);
    }

    // Backup existing → activate candidate
    if (existsSync(destDir)) await rename(destDir, backupDir);

    // Allow tests to inject failure after backup but before activation
    if (opts.beforeActivate) await opts.beforeActivate();

    await rename(candidateDir, destDir);

    // Allow tests to inject failure after activation (triggers rollback)
    if (opts.afterActivate) await opts.afterActivate();

    // Remove backup
    if (existsSync(backupDir)) await rm(backupDir, { recursive: true, force: true });

    const count = (await readdir(destDir, { recursive: true, withFileTypes: true }))
      .filter(e => e.isFile()).length;
    return `staged ${count} files to ${destDir}`;
  } catch (e) {
    // Rollback
    let rollbackFailed = false;
    try {
      // Allow tests to inject failure during rollback
      if (opts.beforeRollback) await opts.beforeRollback();
      if (existsSync(backupDir)) {
        if (existsSync(destDir)) await rm(destDir, { recursive: true, force: true });
        await rename(backupDir, destDir);
      }
    } catch (rollbackErr) {
      rollbackFailed = true;
    }
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    if (rollbackFailed) {
      throw new ImportError(
        `activation failed: ${e.message}. ROLLBACK FAILED — ` +
        `backup may remain at ${backupDir}. Previous payload at ${destDir} may be corrupted. ` +
        `Manual recovery required.`
      );
    }
    throw new ImportError(`activation failed: ${e.message} (previous payload preserved)`);
  } finally {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    // Only remove backup if rollback succeeded (it was restored to destDir)
    if (existsSync(backupDir)) {
      // Backup still exists — rollback may have failed. Leave it for recovery.
      // The caller will see the rollback-failed error message.
    }
  }
}

// ── Core import (exported, no process.exit) ─────────────────────────────────

export async function importPackage(zipPath, destDir = PAYLOAD_DEST) {
  if (!existsSync(zipPath)) throw new ImportError(`ZIP not found: ${zipPath}`);

  const entries = unzipList(zipPath);
  const entryErrs = validateEntries(entries);
  if (entryErrs.length > 0) throw new ImportError(`entries:\n  - ${entryErrs.join('\n  - ')}`);

  const tempDir = path.join(tmpdir(), `fortoid-import-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  try {
    unzipExtract(zipPath, tempDir);

    let pkgRoot = tempDir;
    const tops = await readdir(tempDir, { withFileTypes: true });
    const dirs = tops.filter(e => e.isDirectory());
    if (dirs.length === 1) pkgRoot = path.join(tempDir, dirs[0].name);

    const mfPath = path.join(pkgRoot, MANIFEST_FILENAME);
    if (!existsSync(mfPath)) throw new ImportError(`${MANIFEST_FILENAME} not found`);
    let manifest;
    try { manifest = JSON.parse(await readFile(mfPath, 'utf-8')); }
    catch (e) { throw new ImportError(`manifest.json: invalid JSON: ${e.message}`); }

    const idErr = validateManifestIdentity(manifest);
    if (idErr.length) throw new ImportError(`manifest:\n  - ${idErr.join('\n  - ')}`);
    const fileErr = validateManifestFiles(manifest);
    if (fileErr.length) throw new ImportError(`manifest.files:\n  - ${fileErr.join('\n  - ')}`);
    const ctErr = validateManifestContracts(manifest);
    if (ctErr.length) throw new ImportError(`contracts:\n  - ${ctErr.join('\n  - ')}`);

    const csPath = path.join(pkgRoot, CHECKSUM_FILENAME);
    if (!existsSync(csPath)) throw new ImportError(`${CHECKSUM_FILENAME} not found`);
    const csErr = await validateChecksums(csPath, pkgRoot, manifest);
    if (csErr.length) throw new ImportError(`checksums:\n  - ${csErr.join('\n  - ')}`);

    const rrErr = await validateRuntimeRequirements(pkgRoot, manifest);
    if (rrErr.length) throw new ImportError(`requirements:\n  - ${rrErr.join('\n  - ')}`);

    // Inventory closure: reject files outside manifest.files[] + package metadata
    // Order matters: check symlinks before skipping non-files
    const manifestPaths = new Set(manifest.files.map(f => f.path));
    manifestPaths.add(MANIFEST_FILENAME);
    manifestPaths.add(CHECKSUM_FILENAME);
    const allExtracted = await readdir(pkgRoot, { recursive: true, withFileTypes: true });
    const invErrs = [];
    for (const ent of allExtracted) {
      const rel = path.relative(pkgRoot, path.join(ent.parentPath || ent.path, ent.name));
      if (ent.isSymbolicLink()) {
        invErrs.push(`symlink not allowed: ${rel}`);
        continue;
      }
      if (!ent.isFile()) continue; // directories are structural
      if (!manifestPaths.has(rel)) {
        invErrs.push(`file not in manifest inventory: ${rel}`);
      }
    }
    if (invErrs.length) throw new ImportError(`inventory closure:\n  - ${invErrs.join('\n  - ')}`);

    return await activatePayload(pkgRoot, destDir, EXPECTED_PACKAGE_NAME);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) { console.error('usage: node tools/import-fortweb-runtime-package.mjs <zip>'); process.exit(2); }
  try {
    const msg = await importPackage(zipPath);
    console.error(`[import-fortweb-runtime-package] ${msg}`);
    process.exit(0);
  } catch (e) {
    console.error(`[import-fortweb-runtime-package] ${e.message}`);
    process.exit(1);
  }
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  main();
}

#!/usr/bin/env node

/**
 * Byte-preserving FortWeb runtime package importer for Android.
 *
 * Accepts one FortWeb runtime ZIP, validates archive structure and integrity,
 * and stages the verified package under app/src/main/assets/payload/ without
 * modifying any imported byte.
 *
 * Usage:
 *   node tools/import-fortweb-runtime-package.mjs <runtime-package.zip>
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
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
const ENTRY_DOCUMENT = 'app/index.html';
const MANIFEST_FILENAME = 'manifest.json';
const CHECKSUM_FILENAME = 'checksums.sha256';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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
  if (path.isAbsolute(p)) return false;
  if (p.includes('\\')) return false;
  const normalized = path.normalize(p);
  if (normalized !== p) return false;
  if (normalized.startsWith('..')) return false;
  const segments = normalized.split(path.sep);
  return !segments.includes('..');
}

function panic(msg) {
  console.error(`[import-fortweb-runtime-package] ${msg}`);
  process.exit(1);
}

// ── Unzip using system unzip ─────────────────────────────────────────────────

function unzip(zipPath, destDir) {
  const absZip = path.resolve(zipPath);
  const absDest = path.resolve(destDir);
  try {
    execSync(`unzip -q -o "${absZip}" -d "${absDest}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (e) {
    panic(`unzip failed for ${zipPath}: ${e.stderr?.toString() || e.message}`);
  }
}

function unzipList(zipPath) {
  const absZip = path.resolve(zipPath);
  try {
    const out = execSync(`unzip -Z -1 "${absZip}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return out.toString().trim().split('\n').filter(Boolean);
  } catch (e) {
    panic(`unzip list failed for ${zipPath}: ${e.stderr?.toString() || e.message}`);
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

async function validateEntryList(entries, packageRoot) {
  const errors = [];

  // Check for unsafe entries
  for (const entry of entries) {
    if (!isSafeRelative(entry)) {
      errors.push(`unsafe path: ${entry}`);
      continue;
    }
    if (entry.endsWith('/')) {
      errors.push(`directory entry (not a file): ${entry}`);
    }
  }

  // Check for duplicates
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) {
      errors.push(`duplicate entry: ${entry}`);
    }
    seen.add(entry);
  }

  return errors;
}

async function validateManifest(manifestPath, packageName) {
  const errors = [];
  let manifest;

  try {
    const raw = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw);
  } catch (e) {
    return [`manifest.json invalid: ${e.message}`];
  }

  if (!manifest.package_name) {
    errors.push('manifest.json: missing package_name');
  } else if (manifest.package_name !== EXPECTED_PACKAGE_NAME) {
    errors.push(`manifest.json: expected package_name "${EXPECTED_PACKAGE_NAME}", got "${manifest.package_name}"`);
  }

  if (!manifest.producer) {
    errors.push('manifest.json: missing producer');
  } else if (manifest.producer !== EXPECTED_PRODUCER) {
    errors.push(`manifest.json: expected producer "${EXPECTED_PRODUCER}", got "${manifest.producer}"`);
  }

  if (!manifest.payload_profile) {
    errors.push('manifest.json: missing payload_profile');
  } else if (manifest.payload_profile !== EXPECTED_PROFILE) {
    errors.push(`manifest.json: expected payload_profile "${EXPECTED_PROFILE}", got "${manifest.payload_profile}"`);
  }

  if (!manifest.schema_version) {
    errors.push('manifest.json: missing schema_version');
  }

  if (!manifest.entrypoint) {
    errors.push('manifest.json: missing entrypoint');
  }

  if (!manifest.files || typeof manifest.files !== 'object') {
    errors.push('manifest.json: missing or invalid files map');
  }

  // Verify typed contracts descriptor
  if (!manifest.contracts || typeof manifest.contracts !== 'object') {
    errors.push('manifest.json: missing contracts descriptor');
  } else if (!manifest.contracts.runtime_requirements || !manifest.contracts.runtime_requirements.path) {
    errors.push('manifest.json: missing contracts.runtime_requirements.path');
  }

  return errors;
}

async function validateChecksums(checksumsPath, extractedDir, manifest) {
  const errors = [];
  let checksumsRaw;

  try {
    checksumsRaw = await readFile(checksumsPath, 'utf-8');
  } catch (e) {
    return [`checksums.sha256 missing or unreadable: ${e.message}`];
  }

  const expected = new Map();
  for (const line of checksumsRaw.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/, 2);
    if (parts.length !== 2) {
      errors.push(`checksums.sha256: malformed line: ${trimmed}`);
      continue;
    }
    expected.set(parts[1], parts[0]);
  }

  // Verify every file in the manifest is in checksums and matches
  if (manifest?.files) {
    for (const [relPath, fileInfo] of Object.entries(manifest.files)) {
      const expectedDigest = expected.get(relPath);
      if (!expectedDigest) {
        errors.push(`checksums.sha256: missing entry for manifest file: ${relPath}`);
        continue;
      }

      const filePath = path.join(extractedDir, relPath);
      if (!existsSync(filePath)) {
        errors.push(`checksums.sha256: file not found in extracted archive: ${relPath}`);
        continue;
      }

      try {
        const actualDigest = await sha256File(filePath);
        if (actualDigest !== expectedDigest) {
          errors.push(`checksums.sha256: digest mismatch for ${relPath}: expected ${expectedDigest}, got ${actualDigest}`);
        }
      } catch (e) {
        errors.push(`checksums.sha256: cannot hash ${relPath}: ${e.message}`);
      }

      // Byte count check
      try {
        const stats = await lstat(filePath);
        if (fileInfo.bytes !== undefined && stats.size !== fileInfo.bytes) {
          errors.push(`byte count mismatch for ${relPath}: manifest=${fileInfo.bytes}, actual=${stats.size}`);
        }
      } catch (e) {
        errors.push(`byte count: cannot stat ${relPath}: ${e.message}`);
      }
    }
  }

  // Check for unexpected files
  const manifestFiles = new Set(manifest?.files ? Object.keys(manifest.files) : []);
  for (const [relPath] of expected) {
    if (!manifestFiles.has(relPath)) {
      // checksums-only entry without manifest entry — warn but don't fail
      console.error(`[import-fortweb-runtime-package] checksums has entry not in manifest: ${relPath}`);
    }
  }

  return errors;
}

async function validateRequirementsContract(extractedDir, manifest) {
  const reqPath = manifest?.contracts?.runtime_requirements?.path;
  if (!reqPath) {
    return ['manifest.contracts.runtime_requirements.path: missing'];
  }

  const fullPath = path.join(extractedDir, reqPath);
  if (!existsSync(fullPath)) {
    return [`runtime requirements file not found: ${reqPath}`];
  }

  // Strict UTF-8 validation
  let raw;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (e) {
    return [`runtime requirements: invalid UTF-8: ${e.message}`];
  }

  // Check for U+FFFD replacement characters (sign of non-UTF-8 bytes decoded)
  if (raw.includes('\uFFFD')) {
    return ['runtime requirements: contains U+FFFD replacement characters (invalid UTF-8)'];
  }

  // Valid JSON
  try {
    JSON.parse(raw);
  } catch (e) {
    return [`runtime requirements: invalid JSON: ${e.message}`];
  }

  return [];
}

// ── Staging ──────────────────────────────────────────────────────────────────

async function activatePayload(extractedDir, packageName) {
  // The ZIP root is typically a directory named after the package
  const packageDir = path.join(extractedDir, packageName);

  // If the ZIP wraps in a package-name directory, use that as source
  const sourceDir = existsSync(packageDir) ? packageDir : extractedDir;

  // Clean existing payload
  if (existsSync(PAYLOAD_DEST)) {
    await rm(PAYLOAD_DEST, { recursive: true, force: true });
  }
  await mkdir(PAYLOAD_DEST, { recursive: true });

  // Copy all files preserving structure
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    // Use path.relative against sourceDir to get the relative path within the package
    const entryFull = path.join(entry.parentPath || entry.path, entry.name);
    const relPath = path.relative(sourceDir, entryFull);

    const destPath = path.join(PAYLOAD_DEST, relPath);
    await mkdir(path.dirname(destPath), { recursive: true });

    const buf = await readFile(entryFull);
    await writeFile(destPath, buf);
  }

  const fileCount = (await readdir(PAYLOAD_DEST, { recursive: true, withFileTypes: true }))
    .filter(e => e.isFile()).length;
  console.error(`[import-fortweb-runtime-package] staged ${fileCount} files to ${PAYLOAD_DEST}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    panic('usage: node tools/import-fortweb-runtime-package.mjs <runtime-package.zip>');
  }

  if (!existsSync(zipPath)) {
    panic(`ZIP not found: ${zipPath}`);
  }

  // Phase 1: List entries and validate safety
  const entries = unzipList(zipPath);
  console.error(`[import-fortweb-runtime-package] ZIP contains ${entries.length} entries`);

  let entryErrors = await validateEntryList(entries);
  if (entryErrors.length > 0) {
    for (const err of entryErrors) panic(`entry validation: ${err}`);
  }

  // Phase 2: Extract to temp
  const tempDir = path.join(tmpdir(), `fortoid-import-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  unzip(zipPath, tempDir);

  try {
    // Determine package root (ZIP may wrap in a directory)
    let packageRoot = tempDir;
    const topEntries = await readdir(tempDir, { withFileTypes: true });
    const topDirs = topEntries.filter(e => e.isDirectory());
    if (topDirs.length === 1) {
      packageRoot = path.join(tempDir, topDirs[0].name);
    }

    // Phase 3: Validate manifest
    const manifestPath = path.join(packageRoot, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      panic(`${MANIFEST_FILENAME} not found in package`);
    }

    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } catch (e) {
      panic(`manifest.json parse error: ${e.message}`);
    }

    const manifestErrors = await validateManifest(manifestPath, EXPECTED_PACKAGE_NAME);
    if (manifestErrors.length > 0) {
      for (const err of manifestErrors) panic(err);
    }
    console.error(`[import-fortweb-runtime-package] manifest: ${manifest.package_name} v${manifest.schema_version}, producer=${manifest.producer}, profile=${manifest.payload_profile}`);

    // Phase 4: Validate checksums
    const checksumsPath = path.join(packageRoot, CHECKSUM_FILENAME);
    if (!existsSync(checksumsPath)) {
      panic(`${CHECKSUM_FILENAME} not found in package`);
    }

    const checksumErrors = await validateChecksums(checksumsPath, packageRoot, manifest);
    if (checksumErrors.length > 0) {
      for (const err of checksumErrors) panic(err);
    }
    console.error(`[import-fortweb-runtime-package] checksums: verified`);

    // Phase 5: Validate requirements contract
    const reqErrors = await validateRequirementsContract(packageRoot, manifest);
    if (reqErrors.length > 0) {
      for (const err of reqErrors) panic(err);
    }
    console.error(`[import-fortweb-runtime-package] runtime requirements: present and valid`);

    // Phase 6: Activate payload
    await activatePayload(packageRoot, EXPECTED_PACKAGE_NAME);
    console.error(`[import-fortweb-runtime-package] import complete`);
  } finally {
    // Clean temp
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(`[import-fortweb-runtime-package] fatal: ${e.message}`);
  process.exit(1);
});

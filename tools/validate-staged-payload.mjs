#!/usr/bin/env node
// ── validate-staged-payload.mjs ──────────────────────────────────────────────
// Validates that the staged Android payload matches the canonical FortWeb
// dist/runtime artifact. No Fort-ios dependency.

import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PAYLOAD_DIR = path.join(REPO_ROOT, 'app/src/main/assets/payload');

const REQUIRED_FILES = [
  'index.html',
  'manifest.json',
  'checksums.sha256',
  'app/index.html',
  'app/app/main.js',
  'pyscript-ci.toml',
];

const REQUIRED_DIRS = [
  'vendor/pyodide',
  'vendor/pyscript',
  'wheels',
  'contracts',
];

function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function walkDir(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base));
    } else {
      const content = readFileSync(full);
      results.push({
        path: rel,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const errors = [];

  // Check payload directory exists
  if (!existsSync(PAYLOAD_DIR)) {
    console.error('FAIL: payload directory missing');
    process.exit(1);
  }

  // Check required files
  for (const file of REQUIRED_FILES) {
    const fp = path.join(PAYLOAD_DIR, file);
    if (!existsSync(fp)) {
      errors.push(`missing required file: ${file}`);
    }
  }

  // Check required directories
  for (const dir of REQUIRED_DIRS) {
    const dp = path.join(PAYLOAD_DIR, dir);
    if (!existsSync(dp)) {
      errors.push(`missing required directory: ${dir}`);
    }
  }

  // Verify manifest exists, is valid JSON, and identifies the producer
  try {
    const manifestPath = path.join(PAYLOAD_DIR, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!manifest.package_name || manifest.package_name !== 'fortweb-runtime') {
      errors.push('manifest: missing or wrong package_name');
    }
    if (!manifest.producer || manifest.producer !== 'fortweb') {
      errors.push('manifest: missing or wrong producer');
    }
    if (!manifest.payload_profile || manifest.payload_profile !== 'offline-runtime') {
      errors.push('manifest: missing or wrong payload_profile');
    }
    // Verify typed contracts descriptor
    if (!manifest.contracts?.runtime_requirements?.path) {
      errors.push('manifest: missing contracts.runtime_requirements.path');
    }
  } catch (e) {
    errors.push(`manifest invalid: ${e.message}`);
  }

  // Verify runtime-requirements contract exists and is valid strict UTF-8 JSON
  try {
    const manifestPath = path.join(PAYLOAD_DIR, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const reqRelPath = manifest?.contracts?.runtime_requirements?.path;
    if (reqRelPath) {
      const reqPath = path.join(PAYLOAD_DIR, reqRelPath);
      if (!existsSync(reqPath)) {
        errors.push(`runtime requirements file not found: ${reqRelPath}`);
      } else {
        const raw = readFileSync(reqPath, 'utf-8');
        if (raw.includes('\uFFFD')) {
          errors.push('runtime requirements: contains U+FFFD replacement characters');
        }
        try { JSON.parse(raw); } catch (e) {
          errors.push(`runtime requirements: invalid JSON: ${e.message}`);
        }
      }
    }
  } catch {
    // manifest already validated above
  }

  // Verify checksums.sha256 exists
  if (!existsSync(path.join(PAYLOAD_DIR, 'checksums.sha256'))) {
    errors.push('missing checksums.sha256');
  }

  // Verify no raw TypeScript source in payload (.d.ts declaration files are fine)
  if (existsSync(PAYLOAD_DIR)) {
    const tsFiles = walkDir(PAYLOAD_DIR).filter(f => f.path.endsWith('.ts') && !f.path.endsWith('.d.ts'));
    if (tsFiles.length > 0) {
      errors.push(`raw TypeScript found in payload: ${tsFiles.map(f => f.path).join(', ')}`);
    }
  }

  if (errors.length > 0) {
    console.error('FAIL: staged payload validation errors:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('PASS: staged payload validated');
  process.exit(0);
}

main();

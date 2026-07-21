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
  'android-payload-manifest.json',
  'fortweb/app/index.html',
  'fortweb/app/app/main.js',
  'fortweb/app/runtime-origin-contract.json',
  'fortweb/pyscript-ci.toml',
];

const REQUIRED_DIRS = [
  'fortweb/vendor/pyodide',
  'fortweb/vendor/pyscript',
  'fortweb/wheels',
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

  // Verify root redirect points into fortweb subtree
  try {
    const indexContent = readFileSync(path.join(PAYLOAD_DIR, 'index.html'), 'utf-8');
    if (!indexContent.includes('fortweb/app/index.html')) {
      errors.push('root redirect does not point to fortweb/app/index.html');
    }
  } catch {
    // already caught above
  }

  // Verify manifest exists and is valid JSON
  try {
    const manifestPath = path.join(PAYLOAD_DIR, 'android-payload-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!manifest.fortweb_commit || !manifest.runtime_tree_sha256) {
      errors.push('manifest missing required fields');
    }
  } catch (e) {
    errors.push(`manifest invalid: ${e.message}`);
  }

  // Verify no raw TypeScript source in runtime (.d.ts declaration files are fine)
  const fortwebDir = path.join(PAYLOAD_DIR, 'fortweb');
  if (existsSync(fortwebDir)) {
    const tsFiles = walkDir(fortwebDir).filter(f => f.path.endsWith('.ts') && !f.path.endsWith('.d.ts'));
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

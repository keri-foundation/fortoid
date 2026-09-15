#!/usr/bin/env node

/**
 * Read and validate the Fortoid FortWeb runtime lock.
 *
 * config/fortweb-runtime.json is the single authority for which FortWeb producer
 * revision may be staged into this app. This file is the one implementation of
 * lock parsing and validation, shared by:
 *
 *   sync-payload.sh                                      (developer recovery)
 *   scripts/build-canonical-fortweb-package.sh           (canonical producer)
 *   .github/actions/prepare-fortweb-runtime/action.yml   (CI)
 *
 * Usage:
 *   node tools/read-fortweb-runtime-lock.mjs [--lock-file <path>]
 *
 * On success it prints exactly three machine-readable lines and exits 0:
 *   LOCK_SCHEMA=fortoid.fortweb-runtime-lock.v1
 *   LOCK_REPOSITORY=keri-foundation/fortweb
 *   LOCK_COMMIT=<40-hex>
 *
 * On any problem it prints `error: ...` to stderr and exits 1.
 *
 * `--lock-file` exists so the lock contract can be exercised against fixtures.
 * The shipped recovery flow always uses the repository default, so there is no
 * lock-substitution path in production.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_FILE = path.join(REPO_ROOT, 'config/fortweb-runtime.json');

const EXPECTED_SCHEMA = 'fortoid.fortweb-runtime-lock.v1';
const EXPECTED_REPOSITORY = 'keri-foundation/fortweb';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let lockFile = DEFAULT_LOCK_FILE;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--lock-file') {
    if (!argv[i + 1]) fail('--lock-file requires a path');
    lockFile = path.resolve(argv[i + 1]);
    i += 1;
    continue;
  }
  fail(`unknown argument: ${arg}`);
}

let lock;
try {
  lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
} catch (e) {
  fail(`could not read FortWeb runtime lock ${lockFile}: ${e.message}`);
}

if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
  fail(`lock must be a JSON object: ${lockFile}`);
}

const schema = typeof lock.schema === 'string' ? lock.schema : '';
const repository = typeof lock.repository === 'string' ? lock.repository : '';
const commit = typeof lock.commit === 'string' ? lock.commit : '';

if (schema !== EXPECTED_SCHEMA) {
  fail(`lock schema must be ${EXPECTED_SCHEMA}, got '${schema}'`);
}
if (repository !== EXPECTED_REPOSITORY) {
  fail(`lock repository must be ${EXPECTED_REPOSITORY}, got '${repository}'`);
}
if (!COMMIT_PATTERN.test(commit)) {
  fail(`lock commit must be a full 40-char lowercase SHA, got '${commit}'`);
}

process.stdout.write(
  `LOCK_SCHEMA=${schema}\nLOCK_REPOSITORY=${repository}\nLOCK_COMMIT=${commit}\n`,
);

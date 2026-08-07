#!/usr/bin/env python3
"""Verify a specific JUnit XML suite executed with exact expected results.

Usage:
  python3 tools/verify-junit-suite.py        \
      --results-dir <path>                  \
      --suite <fully.qualified.SuiteName>    \
      --tests <exact-count>

Exit codes:
  0 — suite found, exact count matches, zero failures/errors/skips
  1 — verification failure (suite absent, count mismatch, or test failures)
  2 — invocation error (missing args, missing directory)

Required:
  --results-dir    Directory containing TEST-*.xml (searched recursively)
  --suite          Fully-qualified suite name (exact match)
  --tests          Expected exact test count

Fails if:
  - No XML files found
  - Suite not found
  - More than one matching suite found
  - Test count != expected
  - failures > 0, errors > 0, or skipped > 0
"""

import argparse
import glob
import os
import sys
import xml.etree.ElementTree as ET


def find_suites(results_dir: str, target_name: str):
    """Find all matching suites. Returns list of (filepath, suite_element)."""
    xml_files = glob.glob(os.path.join(results_dir, "**", "TEST-*.xml"), recursive=True)
    if not xml_files:
        return []

    matches = []
    for fp in xml_files:
        try:
            tree = ET.parse(fp)
            root = tree.getroot()
        except ET.ParseError:
            continue
        name = root.get("name", "")
        if name == target_name:
            matches.append((fp, root, tree))
    return matches


def main():
    parser = argparse.ArgumentParser(description="Verify JUnit XML suite results")
    parser.add_argument("--results-dir", required=True, help="Directory with TEST-*.xml files")
    parser.add_argument("--suite", required=True, help="Fully-qualified suite name")
    parser.add_argument("--tests", required=True, type=int, help="Expected exact test count")
    args = parser.parse_args()

    results_dir = args.results_dir
    target = args.suite
    expected = args.tests

    if not os.path.isdir(results_dir):
        print(f"FAIL: results directory not found: {results_dir}", file=sys.stderr)
        sys.exit(2)

    matches = find_suites(results_dir, target)

    if not matches:
        xml_files = glob.glob(os.path.join(results_dir, "**", "TEST-*.xml"), recursive=True)
        if not xml_files:
            print(f"FAIL: no JUnit XML files found in {results_dir}", file=sys.stderr)
        else:
            names = [os.path.basename(f) for f in xml_files]
            print(f"FAIL: suite '{target}' not found", file=sys.stderr)
            print(f"  Found: {names}", file=sys.stderr)
        sys.exit(1)

    if len(matches) > 1:
        files = [fp for fp, _, _ in matches]
        print(f"FAIL: multiple matching suites found for '{target}'", file=sys.stderr)
        print(f"  Files: {files}", file=sys.stderr)
        sys.exit(1)

    fp, root, _ = matches[0]
    tests = int(root.get("tests", 0))
    failures = int(root.get("failures", 0))
    errors = int(root.get("errors", 0))
    skipped = int(root.get("skipped", 0))

    print(f"Suite: {root.get('name', 'unknown')}")

    exit_code = 0

    if tests != expected:
        print(f"FAIL: expected exactly {expected} tests, got {tests}", file=sys.stderr)
        exit_code = 1

    if failures != 0:
        print(f"FAIL: {failures} test(s) failed", file=sys.stderr)
        exit_code = 1

    if errors != 0:
        print(f"FAIL: {errors} test(s) errored", file=sys.stderr)
        exit_code = 1

    if skipped != 0:
        print(f"FAIL: {skipped} test(s) skipped", file=sys.stderr)
        exit_code = 1

    if exit_code == 0:
        print(f"PASS: {tests} tests, 0 failures, 0 errors, 0 skipped")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()

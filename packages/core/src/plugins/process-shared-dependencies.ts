/**
 * processSharedDependencies — utility for generating shared dependency
 * JavaScript string fragments used in the `__mf_container__.shared` map.
 *
 * Requirements: 3.4, 3.5, 7.1, 7.2
 */

import type { SharedConfig, SharedLibraryConfig } from '../types/index.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Version resolver
// ---------------------------------------------------------------------------

const _versionCache = new Map<string, string>();

/**
 * Resolves the installed version of `packageName` from its `package.json`.
 * Falls back to `'*'` when the package cannot be found.
 */
function resolveInstalledVersion(packageName: string): string {
  if (_versionCache.has(packageName)) {
    return _versionCache.get(packageName)!;
  }

  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    const pkgJsonPath = req.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
    const version = pkg.version ?? '*';
    _versionCache.set(packageName, version);
    return version;
  } catch {
    _versionCache.set(packageName, '*');
    return '*';
  }
}

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

/**
 * Serialises a single shared library config entry into a JavaScript object
 * literal fragment suitable for embedding inside `__mf_container__.shared`.
 */
function buildSharedEntry(
  packageName: string,
  config: SharedLibraryConfig,
): string {
  // Auto-resolve version from installed package.json when not provided (Req 3.5)
  const version = config.version ?? resolveInstalledVersion(packageName);
  const singleton = config.singleton ?? false;
  const strictVersion = config.strictVersion ?? false;

  return (
    `"${packageName}": { ` +
    `version: "${version}", ` +
    `singleton: ${singleton}, ` +
    `strictVersion: ${strictVersion}, ` +
    `get: async () => import("${packageName}") ` +
    `}`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts a `SharedConfig` map into an array of JavaScript string fragments,
 * each representing one entry in the `__mf_container__.shared` object literal.
 *
 * Requirements: 3.4, 3.5, 7.1, 7.2
 */
export function processSharedDependencies(shared: SharedConfig): string[] {
  return Object.entries(shared).map(([packageName, config]) =>
    buildSharedEntry(packageName, config),
  );
}

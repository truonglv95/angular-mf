/**
 * `withModuleFederation()` — MF Config helper
 *
 * Validates and normalises a raw `ModuleFederationConfig` before it is
 * consumed by the build and runtime layers.
 *
 * Requirements: 2.5, 2.6, 2.7, 2.8
 */

import type { ModuleFederationConfig, SharedConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Angular peer-dependency defaults
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reads package.json and returns all @angular/* packages to be shared.
 * This guarantees all Angular internal DI contexts remain singletons, preventing NG0203.
 */
function getAngularSharedDefaults(): SharedConfig {
  const defaults: SharedConfig = {
    '@angular/core': { singleton: true, strictVersion: true },
    '@angular/common': { singleton: true, strictVersion: true },
    '@angular/router': { singleton: true, strictVersion: true },
  };

  try {
    const pkgJsonPath = path.resolve(process.cwd(), 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const deps = pkg.dependencies || {};
      for (const key of Object.keys(deps)) {
        if (key.startsWith('@angular/') && !key.startsWith('@angular-mf/')) {
          defaults[key] = { singleton: true, strictVersion: true };
        }
      }
    }
  } catch (e) {
    console.warn('[MF] Failed to auto-detect Angular packages', e);
  }

  return defaults;
}

const ANGULAR_SINGLETON_DEFAULTS: SharedConfig = getAngularSharedDefaults();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that `name` is non-empty and contains no whitespace characters.
 *
 * @throws {Error} with a descriptive message when the constraint is violated.
 *
 * Requirement 2.6
 */
function validateName(name: string): void {
  if (name.length === 0) {
    throw new Error(
      '[MF] withModuleFederation(): `config.name` must not be empty. ' +
        'Provide a unique alphanumeric identifier (hyphens and underscores are allowed).',
    );
  }

  if (/\s/.test(name)) {
    throw new Error(
      `[MF] withModuleFederation(): \`config.name\` must not contain whitespace, ` +
        `got: "${name}". Use alphanumeric characters, hyphens (-), or underscores (_) only.`,
    );
  }
}

/**
 * Asserts that every key in the `exposes` map starts with `'./'`.
 *
 * @throws {Error} with a descriptive message listing all invalid keys.
 *
 * Requirement 2.2 (enforced at config-helper level)
 */
function validateExposes(exposes: Record<string, string>): void {
  const invalidKeys = Object.keys(exposes).filter((key) => !key.startsWith('./'));

  if (invalidKeys.length > 0) {
    throw new Error(
      `[MF] withModuleFederation(): every key in \`config.exposes\` must start with './', ` +
        `but the following key(s) do not: ${invalidKeys.map((k) => `"${k}"`).join(', ')}. ` +
        `Example of a valid key: './Component'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates and normalises a `ModuleFederationConfig`.
 *
 * **What this function does:**
 * 1. Validates `config.name` (non-empty, no whitespace).
 * 2. Validates every key in `config.exposes` starts with `'./'`.
 * 3. Applies the default filename `'remoteEntry.js'` when `config.filename` is absent.
 * 4. Builds an auto-detected Angular shared-dependency baseline
 *    (`@angular/core`, `@angular/common`, `@angular/router` as singletons).
 * 5. Resolves the final `shared` config:
 *    - If `config.shared` is a **function**, calls it with the Angular defaults
 *      and uses the returned value (Requirement 2.8).
 *    - If `config.shared` is an **object**, merges it on top of the Angular
 *      defaults so that explicit entries take precedence (Requirement 2.7).
 *    - If `config.shared` is absent, uses the Angular defaults as-is.
 * 6. Returns the fully normalised `ModuleFederationConfig`.
 *
 * @param config - Raw MF configuration provided by the developer.
 * @returns Normalised `ModuleFederationConfig` ready for the build pipeline.
 *
 * @throws {Error} When `config.name` is empty or contains whitespace.
 * @throws {Error} When any key in `config.exposes` does not start with `'./'`.
 *
 * Requirements: 2.5, 2.6, 2.7, 2.8
 */
export function withModuleFederation(
  config: ModuleFederationConfig,
): ModuleFederationConfig {
  // ── 1. Validate name ──────────────────────────────────────────────────────
  validateName(config.name);

  // ── 2. Validate exposes keys ──────────────────────────────────────────────
  if (config.exposes !== undefined) {
    validateExposes(config.exposes);
  }

  // ── 3. Default filename ───────────────────────────────────────────────────
  const filename = config.filename ?? 'remoteEntry.js';

  // ── 4 & 5. Resolve shared config ──────────────────────────────────────────
  const angularDefaults: SharedConfig = { ...ANGULAR_SINGLETON_DEFAULTS };

  let resolvedShared: SharedConfig;

  if (typeof config.shared === 'function') {
    // Req 2.8: call the function with auto-detected Angular defaults
    resolvedShared = config.shared(angularDefaults);
  } else if (config.shared !== undefined) {
    // Req 2.7: merge explicit config on top of Angular defaults;
    // explicit entries override the defaults for matching packages.
    resolvedShared = { ...angularDefaults, ...config.shared };
  } else {
    // No shared config provided — use Angular defaults only.
    resolvedShared = angularDefaults;
  }

  // ── 6. Return normalised config ───────────────────────────────────────────
  return {
    ...config,
    filename,
    shared: resolvedShared,
  };
}

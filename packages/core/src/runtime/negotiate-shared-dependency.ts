/**
 * Shared dependency version negotiation — Algorithm 2
 *
 * Determines how a specific shared package should be resolved between the host
 * application and a remote Module Federation container.
 *
 * Decision tree:
 *  1. No host entry           → resolved: 'remote',       use remote factory
 *  2. Singleton + compatible  → resolved: 'host',         use host factory
 *  3. Singleton + incompatible + strictVersion → throw SharedVersionMismatchError
 *  4. Singleton + incompatible (non-strict)    → warn + resolved: 'host', use host factory
 *  5. Non-singleton + compatible   → resolved: 'host',         use host factory
 *  6. Non-singleton + incompatible → resolved: 'new-instance', use remote factory
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { SharedVersionMismatchError } from '../errors.js';
import type {
  SharedDependencyNegotiation,
  SharedLibraryConfig,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Inline semver compatibility check (avoids shipping the CJS `semver` package)
// ---------------------------------------------------------------------------

/**
 * Parses a semver string (e.g. "17.2.1") into a numeric tuple.
 * Returns null if the string is not a valid X.Y.Z version.
 */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Checks whether `version` satisfies the semver `range`.
 *
 * Supports the following range formats used in Angular/npm ecosystems:
 *  - `*`   or `''` → always compatible
 *  - `x.y.z`       → exact match
 *  - `^x.y.z`      → same major, any minor/patch ≥ y.z
 *  - `~x.y.z`      → same major.minor, any patch ≥ z
 *  - `>=x.y.z`     → version ≥ x.y.z
 *  - `>x.y.z`      → version > x.y.z
 *  - `<=x.y.z`     → version ≤ x.y.z
 *  - `<x.y.z`      → version < x.y.z
 *
 * Unrecognised ranges default to `true` (lenient) to avoid false rejections.
 */
export function semverSatisfies(version: string, range: string): boolean {
  const r = range.trim();

  // Wildcard / empty range → always compatible
  if (r === '*' || r === '' || r === 'latest') return true;

  const v = parseSemver(version);
  if (!v) return true; // unparseable version → be lenient

  // Caret: ^x.y.z → same major, minor.patch ≥ y.z
  const caret = r.match(/^\^(\d+\.\d+\.\d+.*)/);
  if (caret) {
    const req = parseSemver(caret[1]);
    if (!req) return true;
    if (v[0] !== req[0]) return false;
    if (v[1] > req[1]) return true;
    if (v[1] < req[1]) return false;
    return v[2] >= req[2];
  }

  // Tilde: ~x.y.z → same major.minor, patch ≥ z
  const tilde = r.match(/^~(\d+\.\d+\.\d+.*)/);
  if (tilde) {
    const req = parseSemver(tilde[1]);
    if (!req) return true;
    if (v[0] !== req[0] || v[1] !== req[1]) return false;
    return v[2] >= req[2];
  }

  // >= x.y.z
  const gte = r.match(/^>=(\d+\.\d+\.\d+.*)/);
  if (gte) {
    const req = parseSemver(gte[1]);
    if (!req) return true;
    if (v[0] !== req[0]) return v[0] > req[0];
    if (v[1] !== req[1]) return v[1] > req[1];
    return v[2] >= req[2];
  }

  // > x.y.z
  const gt = r.match(/^>(\d+\.\d+\.\d+.*)/);
  if (gt) {
    const req = parseSemver(gt[1]);
    if (!req) return true;
    if (v[0] !== req[0]) return v[0] > req[0];
    if (v[1] !== req[1]) return v[1] > req[1];
    return v[2] > req[2];
  }

  // <= x.y.z
  const lte = r.match(/^<=(\d+\.\d+\.\d+.*)/);
  if (lte) {
    const req = parseSemver(lte[1]);
    if (!req) return true;
    if (v[0] !== req[0]) return v[0] < req[0];
    if (v[1] !== req[1]) return v[1] < req[1];
    return v[2] <= req[2];
  }

  // < x.y.z
  const lt = r.match(/^<(\d+\.\d+\.\d+.*)/);
  if (lt) {
    const req = parseSemver(lt[1]);
    if (!req) return true;
    if (v[0] !== req[0]) return v[0] < req[0];
    if (v[1] !== req[1]) return v[1] < req[1];
    return v[2] < req[2];
  }

  // Exact version
  const exact = parseSemver(r);
  if (exact) {
    return v[0] === exact[0] && v[1] === exact[1] && v[2] === exact[2];
  }

  // Unknown range format → be lenient
  return true;
}

// ---------------------------------------------------------------------------
// Main negotiation function
// ---------------------------------------------------------------------------

/**
 * Negotiate which version of a shared dependency should be used.
 *
 * @param packageName  - npm package name (e.g. `'@angular/core'`)
 * @param remoteVersion - Semver range / version string requested by the remote
 * @param remoteConfig  - Remote's shared library config including async `get` factory
 * @returns A {@link SharedDependencyNegotiation} describing how the dep was resolved
 * @throws {SharedVersionMismatchError} When singleton + strictVersion + incompatible versions
 *
 * Preconditions:
 * - `packageName` is a valid npm package name
 * - `remoteVersion` is a valid semver string or range
 * - `remoteConfig.get` is an async factory function
 *
 * Postconditions:
 * - Returns `SharedDependencyNegotiation` with `resolved` ∈ `'host' | 'remote' | 'new-instance'`
 * - Pure / deterministic: same inputs always produce an equal result (Requirement 7.8)
 */
export async function negotiateSharedDependency(
  packageName: string,
  remoteVersion: string,
  remoteConfig: SharedLibraryConfig & { get: () => Promise<unknown> },
): Promise<SharedDependencyNegotiation> {
  // Read the host's shared scope from the global registry.
  const hostScope = globalThis.__MF_SHARED__ ?? {};
  const hostEntry = hostScope[packageName];

  // ── Branch 1: Host does not have this dependency ─────────────────────────
  // Requirement 7.7 — use remote's own factory.
  if (!hostEntry) {
    return {
      resolved: 'remote',
      factory: remoteConfig.get,
      providedVersion: remoteVersion,
      requestedVersion: remoteVersion,
      singleton: remoteConfig.singleton ?? false,
    };
  }

  // Check semver compatibility: does the host version satisfy the remote's
  // required range?
  const isCompatible = semverSatisfies(String(hostEntry.version), remoteVersion);

  // ── Singleton branches ────────────────────────────────────────────────────
  if (remoteConfig.singleton) {
    if (!isCompatible) {
      // Branch 3: strictVersion → throw (Requirement 7.4)
      if (remoteConfig.strictVersion) {
        throw new SharedVersionMismatchError(
          packageName,
          remoteVersion,
          String(hostEntry.version),
        );
      }

      // Branch 4: non-strict → warn and still use host version (Requirement 7.3)
      console.warn(
        `[MF] Shared singleton "${packageName}": remote requires "${remoteVersion}", ` +
          `using host "${hostEntry.version}"`,
      );
    }

    // Branch 2 & 4: singleton always resolves to host (Requirement 7.1)
    return {
      resolved: 'host',
      factory: hostEntry.factory,
      providedVersion: String(hostEntry.version),
      requestedVersion: remoteVersion,
      singleton: true,
    };
  }

  // ── Non-singleton branches ────────────────────────────────────────────────

  // Branch 5: non-singleton + compatible → use host version (Requirement 7.5)
  if (isCompatible) {
    return {
      resolved: 'host',
      factory: hostEntry.factory,
      providedVersion: String(hostEntry.version),
      requestedVersion: remoteVersion,
      singleton: false,
    };
  }

  // Branch 6: non-singleton + incompatible → load new instance from remote
  // (Requirement 7.6)
  return {
    resolved: 'new-instance',
    factory: remoteConfig.get,
    providedVersion: remoteVersion,
    requestedVersion: remoteVersion,
    singleton: false,
  };
}

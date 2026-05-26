/**
 * Property-based tests for `negotiateSharedDependency()`
 *
 * Property 5: Version Negotiation Determinism
 * Property 8: Strict Singleton Version Mismatch Always Throws
 *
 * **Validates: Requirements 7.4, 7.8, 9.2**
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import semver from 'semver';
import { negotiateSharedDependency } from './negotiate-shared-dependency.js';
import { SharedVersionMismatchError } from '../errors.js';
import type { SharedLibraryConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Package names: alphanumeric + hyphens, starting with a letter, 1-20 chars.
 * Covers typical npm package names like 'lodash', 'my-lib', 'angular-core'.
 */
const packageNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,19}$/);

/**
 * Semver version strings of the form MAJOR.MINOR.PATCH.
 * e.g. '1.2.3', '17.0.0', '3.5.9'
 */
const semverVersionArb = fc
  .tuple(
    fc.integer({ min: 1, max: 17 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/**
 * Generates pairs of incompatible semver versions:
 * - `hostVersion`   uses major N   (e.g. '3.0.0')
 * - `remoteVersion` uses major N+1 (e.g. '4.0.0')
 *
 * Because an exact semver like '4.0.0' only matches '4.0.0', not '3.0.0',
 * these pairs are guaranteed to be incompatible under `semver.satisfies`.
 */
const incompatibleVersionPairArb = fc.integer({ min: 1, max: 8 }).map((hostMajor) => ({
  hostVersion: `${hostMajor}.0.0`,
  remoteVersion: `${hostMajor + 1}.0.0`,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRemoteConfig(
  get: () => Promise<unknown>,
  overrides: Partial<SharedLibraryConfig> = {},
): SharedLibraryConfig & { get: () => Promise<unknown> } {
  return { singleton: false, strictVersion: false, get, ...overrides };
}

// ---------------------------------------------------------------------------
// Property 5: Version Negotiation Determinism
// **Validates: Requirements 7.8**
// ---------------------------------------------------------------------------

describe('Property 5: Version Negotiation Determinism', () => {
  afterEach(() => {
    globalThis.__MF_SHARED__ = undefined;
  });

  it(
    'produces deepEqual results for the same (packageName, remoteVersion, sharedConfig) inputs',
    async () => {
      await fc.assert(
        fc.asyncProperty(packageNameArb, semverVersionArb, async (packageName, version) => {
          // Set up a compatible host entry: using the same `version` string ensures
          // semver.satisfies(version, version) === true, so we stay in a non-throwing branch.
          const hostFactory = async (): Promise<unknown> => ({ instance: 'host' });
          globalThis.__MF_SHARED__ = {
            [packageName]: {
              version,
              singleton: false,
              factory: hostFactory,
            },
          };

          try {
            const remoteGet = async (): Promise<unknown> => ({ instance: 'remote' });
            // singleton: false avoids any throw path, making the function pure/deterministic.
            const config = makeRemoteConfig(remoteGet, { singleton: false, strictVersion: false });

            const result1 = await negotiateSharedDependency(packageName, version, config);
            const result2 = await negotiateSharedDependency(packageName, version, config);

            // Both results must be structurally equal (same resolved, versions, singleton flag,
            // and identical factory reference from the same host entry / config object).
            expect(result1).toEqual(result2);
          } finally {
            globalThis.__MF_SHARED__ = undefined;
          }
        }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 8: Strict Singleton Version Mismatch Always Throws
// **Validates: Requirements 7.4, 9.2**
// ---------------------------------------------------------------------------

describe('Property 8: Strict Singleton Version Mismatch Always Throws', () => {
  afterEach(() => {
    globalThis.__MF_SHARED__ = undefined;
  });

  it(
    'always throws SharedVersionMismatchError when singleton+strictVersion with incompatible versions',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          packageNameArb,
          incompatibleVersionPairArb,
          async (packageName, { hostVersion, remoteVersion }) => {
            // Guard: confirm the pair is genuinely incompatible before asserting.
            // With our generation strategy (different major versions) this always holds,
            // but fc.pre keeps the contract explicit.
            fc.pre(!semver.satisfies(hostVersion, remoteVersion));

            globalThis.__MF_SHARED__ = {
              [packageName]: {
                version: hostVersion,
                singleton: true,
                factory: async () => ({}),
              },
            };

            try {
              const config = makeRemoteConfig(async () => ({}), {
                singleton: true,
                strictVersion: true,
              });

              // The function MUST throw because:
              //   singleton: true + strictVersion: true + versions incompatible → error
              await expect(
                negotiateSharedDependency(packageName, remoteVersion, config),
              ).rejects.toBeInstanceOf(SharedVersionMismatchError);
            } finally {
              globalThis.__MF_SHARED__ = undefined;
            }
          },
        ),
      );
    },
  );
});

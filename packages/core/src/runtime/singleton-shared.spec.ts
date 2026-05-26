/**
 * Property-based test for `negotiateSharedDependency()`
 *
 * Property 2: Singleton Shared Dependency Instance
 * For any singleton package, host and remote resolve to the same instance
 * (same factory reference, `resolved: 'host'`).
 *
 * **Validates: Requirements 7.1, 7.2**
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { negotiateSharedDependency } from './negotiate-shared-dependency.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Package names: alphanumeric + hyphens, starting with a letter, 1–20 chars.
 * e.g. 'lodash', 'angular-core', 'my-lib'
 */
const packageNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,19}$/);

/**
 * Semver version strings of the form MAJOR.MINOR.PATCH,
 * with MAJOR in [1, 17]. e.g. '1.0.0', '3.5.9', '17.0.0'
 */
const versionArb = fc
  .tuple(
    fc.integer({ min: 1, max: 17 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

// ---------------------------------------------------------------------------
// Property 2: Singleton Shared Dependency Instance
// **Validates: Requirements 7.1, 7.2**
// ---------------------------------------------------------------------------

describe('Property 2: Singleton Shared Dependency Instance', () => {
  afterEach(() => {
    globalThis.__MF_SHARED__ = undefined;
  });

  it(
    'always resolves to host instance (resolved: "host") with host factory for any singleton package',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          packageNameArb,
          versionArb,
          async (packageName, version) => {
            // Set up a singleton host entry in the global shared scope.
            // Using the same `version` for both host and remote guarantees
            // semver.satisfies(version, version) === true, so we stay in
            // the compatible + singleton branch (no warning, no throw).
            const hostFactory = async (): Promise<unknown> => ({ instance: 'host' });

            globalThis.__MF_SHARED__ = {
              [packageName]: {
                version,
                singleton: true,
                factory: hostFactory,
              },
            };

            try {
              const remoteFactory = async (): Promise<unknown> => ({ instance: 'remote' });

              const result = await negotiateSharedDependency(
                packageName,
                version,
                {
                  singleton: true,
                  strictVersion: false,
                  get: remoteFactory,
                },
              );

              // For a singleton package, the runtime must always use the host's
              // existing instance — never the remote's (Requirement 7.1).
              expect(result.resolved).toBe('host');

              // The factory reference must point to the host's factory,
              // proving the same instance is used across all remotes (Requirement 7.2).
              expect(result.factory).toBe(hostFactory);
            } finally {
              globalThis.__MF_SHARED__ = undefined;
            }
          },
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Unit test: Singleton Shared Dependency — concrete example
// **Validates: Requirements 7.1, 7.2**
// ---------------------------------------------------------------------------

describe('Singleton Shared Dependency — unit test', () => {
  afterEach(() => {
    globalThis.__MF_SHARED__ = undefined;
  });

  it('resolves @angular/core singleton to the host factory with a compatible version', async () => {
    const hostFactory = async (): Promise<unknown> => ({ ngCore: 'host-instance' });

    globalThis.__MF_SHARED__ = {
      '@angular/core': {
        version: '17.0.0',
        singleton: true,
        factory: hostFactory,
      },
    };

    const remoteFactory = async (): Promise<unknown> => ({ ngCore: 'remote-instance' });

    const result = await negotiateSharedDependency(
      '@angular/core',
      '17.0.0',
      {
        singleton: true,
        strictVersion: false,
        get: remoteFactory,
      },
    );

    // Must resolve to the host's instance
    expect(result.resolved).toBe('host');
    // Factory reference must be the host's factory — same object identity
    expect(result.factory).toBe(hostFactory);
    expect(result.singleton).toBe(true);
    expect(result.providedVersion).toBe('17.0.0');
    expect(result.requestedVersion).toBe('17.0.0');
  });
});

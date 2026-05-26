/**
 * Unit tests for `loadRemoteModule()`
 *
 * Covers:
 *  - Argument validation (exposedModule must start with './')
 *  - Remote not found (not in manifest, no remoteEntry)
 *  - Network failure → RemoteLoadError with metadata
 *  - Container not registered after script load → RemoteContainerInitError
 *  - ExposedModule not in container.exposes → ExposedModuleNotFoundError
 *  - config.remoteEntry overrides manifest URL
 *  - Property 9: Error Metadata Completeness
 *
 * **Validates: Requirements 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 11.1, 9.1**
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  ExposedModuleNotFoundError,
  RemoteContainerInitError,
  RemoteLoadError,
  RemoteNotFoundError,
} from '../errors.js';
import { clearContainerCache, loadRemoteModule } from './load-remote-module.js';
import type { RemoteContainer, RemoteManifest } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A local file URL that Node.js ESM can actually `import()` without error.
 * `errors.js` is a plain module that does NOT register __MF_CONTAINERS__,
 * making it useful for RemoteContainerInitError tests.
 * For success-path tests, we pre-populate __MF_CONTAINERS__ BEFORE calling
 * loadRemoteModule so that even though errors.js doesn't register anything,
 * the container is already there when loadScript resolves.
 */
const LOCAL_IMPORTABLE_URL = new URL('../errors.js', import.meta.url).href;

/**
 * A URL that Node.js ESM cannot import (http scheme is not supported by the
 * default loader). Used for RemoteLoadError tests and error-path tests where
 * we don't need the container to be initialised.
 */
const HTTP_FAIL_URL = 'http://nonexistent.invalid/remoteEntry.js';

/**
 * Build a minimal pre-registered RemoteContainer and install it in the global.
 * Call `clearContainerCache()` + reset the global after each test to avoid
 * cross-test pollution.
 */
function registerContainer(
  remoteName: string,
  exposes: Record<string, () => Promise<unknown>> = {},
): RemoteContainer {
  const container: RemoteContainer = {
    name: remoteName,
    version: '1.0.0',
    shared: {},
    exposes,
  };

  globalThis.__MF_CONTAINERS__ ??= {};
  globalThis.__MF_CONTAINERS__[remoteName] = container;

  return container;
}

/** Set up a minimal manifest entry. */
function registerManifest(entries: Record<string, string>): void {
  globalThis.__MF_MANIFEST__ = Object.fromEntries(
    Object.entries(entries).map(([name, url]) => [name, { remoteEntry: url }]),
  ) as RemoteManifest;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearContainerCache();
  globalThis.__MF_MANIFEST__ = undefined;
  globalThis.__MF_CONTAINERS__ = undefined;
  globalThis.__MF_SHARED__ = undefined;
});

afterEach(() => {
  clearContainerCache();
  globalThis.__MF_MANIFEST__ = undefined;
  globalThis.__MF_CONTAINERS__ = undefined;
  globalThis.__MF_SHARED__ = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Requirement 6.10 — exposedModule must start with './'
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — exposedModule validation', () => {
  it('throws TypeError when exposedModule does not start with "./"', async () => {
    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: 'Component' }),
    ).rejects.toThrow(TypeError);
  });

  it('throws with a message containing "./" when prefix is missing', async () => {
    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: 'Component' }),
    ).rejects.toThrow('./');
  });

  it('throws when exposedModule uses an absolute path', async () => {
    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: '/Component' }),
    ).rejects.toThrow(TypeError);
  });

  it('does NOT throw a TypeError when exposedModule starts with "./"', async () => {
    // Register the container in __MF_CONTAINERS__ BEFORE loadScript is called.
    // loadScript will import LOCAL_IMPORTABLE_URL (which succeeds but doesn't
    // register the container). Because we pre-registered it, the container
    // check passes and the call succeeds end-to-end.
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', { './Component': async () => ({ default: {} }) });

    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.6 — RemoteNotFoundError when remote is unknown
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — RemoteNotFoundError', () => {
  it('throws RemoteNotFoundError when remoteName is not in manifest and no remoteEntry is given', async () => {
    // Empty manifest, no remoteEntry override.
    globalThis.__MF_MANIFEST__ = {};

    await expect(
      loadRemoteModule({ remoteName: 'unknown-remote', exposedModule: './Component' }),
    ).rejects.toBeInstanceOf(RemoteNotFoundError);
  });

  it('throws RemoteNotFoundError when manifest is undefined and no remoteEntry is given', async () => {
    // __MF_MANIFEST__ stays undefined.
    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' }),
    ).rejects.toBeInstanceOf(RemoteNotFoundError);
  });

  it('error message contains the remote name', async () => {
    await expect(
      loadRemoteModule({ remoteName: 'my-remote', exposedModule: './Module' }),
    ).rejects.toThrow('my-remote');
  });

  it('does NOT throw RemoteNotFoundError when config.remoteEntry is provided', async () => {
    // Container is pre-registered so the call can succeed.
    registerContainer('mfe1', { './Component': async () => ({}) });

    // Even though manifest is empty, the explicit remoteEntry must be used.
    // Because the import() for the fake URL will fail in Node, the error must
    // NOT be RemoteNotFoundError — it should be RemoteLoadError instead.
    await expect(
      loadRemoteModule({
        remoteName: 'mfe1',
        exposedModule: './Component',
        remoteEntry: 'http://localhost:4201/remoteEntry.js',
      }),
    ).rejects.not.toBeInstanceOf(RemoteNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.5 — config.remoteEntry overrides manifest URL
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — config.remoteEntry override', () => {
  it('uses config.remoteEntry URL instead of manifest URL', async () => {
    // Register a manifest entry pointing to a "wrong" URL.
    registerManifest({ mfe1: 'http://manifest-url.example.com/remoteEntry.js' });

    // Provide an explicit override URL pointing to a known-failing http URL.
    // This proves the override URL was used (not the manifest URL), because:
    // - The error's .url field tells us exactly which URL was attempted.
    const overrideUrl = HTTP_FAIL_URL;

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
      remoteEntry: overrideUrl,
    }).catch((e: unknown) => e);

    // The error should be RemoteLoadError (network failure) not
    // RemoteNotFoundError, proving the override URL was tried.
    expect(err).toBeInstanceOf(RemoteLoadError);
    expect((err as RemoteLoadError).url).toBe(overrideUrl);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.7 / 9.1 — RemoteLoadError when script fails to load
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — RemoteLoadError', () => {
  it('throws RemoteLoadError when the remote script cannot be fetched', async () => {
    registerManifest({ mfe1: 'http://nonexistent.invalid/remoteEntry.js' });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteLoadError);
  });

  it('RemoteLoadError contains the correct remoteName', async () => {
    registerManifest({ mfe1: 'http://nonexistent.invalid/remoteEntry.js' });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteLoadError);
    expect((err as RemoteLoadError).remoteName).toBe('mfe1');
  });

  it('RemoteLoadError contains the attempted URL', async () => {
    const url = 'http://nonexistent.invalid/remoteEntry.js';
    registerManifest({ mfe1: url });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteLoadError);
    expect((err as RemoteLoadError).url).toBe(url);
  });

  it('RemoteLoadError has a non-null cause', async () => {
    registerManifest({ mfe1: 'http://nonexistent.invalid/remoteEntry.js' });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteLoadError);
    expect((err as RemoteLoadError).cause).not.toBeNull();
  });

  it('RemoteLoadError.cause is an Error instance', async () => {
    registerManifest({ mfe1: 'http://nonexistent.invalid/remoteEntry.js' });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteLoadError);
    expect((err as RemoteLoadError).cause).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.8 — RemoteContainerInitError when container not registered
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — RemoteContainerInitError', () => {
  it('throws RemoteContainerInitError when script loads but container is not registered', async () => {
    // LOCAL_IMPORTABLE_URL points to errors.js — a valid ESM file that
    // Node can import() but that does NOT register __MF_CONTAINERS__.
    // So: loadScript() succeeds, but the container check fails → RemoteContainerInitError.
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    // Do NOT register the container — errors.js won't do it.

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteContainerInitError);
  });

  it('RemoteContainerInitError contains the remote name', async () => {
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Component',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteContainerInitError);
    expect((err as RemoteContainerInitError).remoteName).toBe('mfe1');
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.9 — ExposedModuleNotFoundError
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — ExposedModuleNotFoundError', () => {
  it('throws ExposedModuleNotFoundError when exposedModule is not in container.exposes', async () => {
    // Pre-register container with empty exposes map.
    // Use LOCAL_IMPORTABLE_URL so loadScript(url) succeeds in Node.
    // The pre-registered container is found after the import resolves.
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', {}); // empty exposes

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './NonExistent',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExposedModuleNotFoundError);
  });

  it('error contains the remoteName', async () => {
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', {});

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './Foo',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExposedModuleNotFoundError);
    expect((err as ExposedModuleNotFoundError).remoteName).toBe('mfe1');
  });

  it('error contains the requested exposedPath', async () => {
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', { './Component': async () => ({}) });

    const err = await loadRemoteModule({
      remoteName: 'mfe1',
      exposedModule: './NonExistent',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExposedModuleNotFoundError);
    expect((err as ExposedModuleNotFoundError).exposedPath).toBe('./NonExistent');
  });

  it('returns module when exposedModule exists in container', async () => {
    const moduleExports = { default: { selector: 'app-remote' } };
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', {
      './Component': async () => moduleExports,
    });

    const result = await loadRemoteModule<typeof moduleExports>({
      remoteName: 'mfe1',
      exposedModule: './Component',
    });

    expect(result).toEqual(moduleExports);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.3 / 6.4 — Container caching (idempotent loading)
// ---------------------------------------------------------------------------

describe('loadRemoteModule() — container caching', () => {
  it('returns the same result on consecutive calls for the same remote and exposedModule', async () => {
    const moduleExports = { default: { name: 'RemoteComp' } };
    // Use LOCAL_IMPORTABLE_URL so loadScript succeeds in Node.
    // Pre-register container so the container check passes after the import.
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', {
      './Component': async () => moduleExports,
    });

    const result1 = await loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' });
    const result2 = await loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' });

    expect(result1).toBe(result2);
  });

  it('does not attempt to re-load the script for a cached remote', async () => {
    const moduleExports = { default: {} };
    registerManifest({ mfe1: LOCAL_IMPORTABLE_URL });
    registerContainer('mfe1', {
      './Component': async () => moduleExports,
    });

    // First call — loads and caches the container.
    await loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' });

    // Remove the container from __MF_CONTAINERS__ to prove that the second
    // call does NOT attempt to re-load the script.
    // The manifest is kept because URL resolution still happens before the
    // cache check in the implementation (Req 6.6 requires a valid URL).
    globalThis.__MF_CONTAINERS__ = undefined;

    // Second call must succeed via the loadedContainers cache — if it tried
    // to re-run loadScript, it would find no container and throw
    // RemoteContainerInitError. Success here proves caching works.
    await expect(
      loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Property 9: Error Metadata Completeness
// Validates: Requirements 6.7, 9.1
//
// For any remote load failure, the thrown RemoteLoadError always contains
// non-empty remoteName, attempted url, and non-null cause.
// ---------------------------------------------------------------------------

describe('Property 9: Error Metadata Completeness', () => {
  /**
   * **Validates: Requirements 6.7, 9.1**
   *
   * Strategy:
   *  - Generate arbitrary remoteName strings (non-empty, alphanumeric-ish).
   *  - Use an http URL that Node.js cannot dynamically import (any http URL
   *    will fail in a Node ESM environment without a network loader).
   *  - Catch the resulting error and assert it is a RemoteLoadError with
   *    non-empty remoteName, matching url, and non-null cause.
   */
  it(
    'RemoteLoadError always has non-empty remoteName, attempted url, and non-null cause',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate valid remote names (non-empty, no whitespace)
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/),
          async (remoteName) => {
            clearContainerCache();
            globalThis.__MF_MANIFEST__ = undefined;
            globalThis.__MF_CONTAINERS__ = undefined;

            // Use a URL that will definitely fail in Node (no network import loader).
            const url = `http://nonexistent-${remoteName}.invalid/remoteEntry.js`;
            registerManifest({ [remoteName]: url });

            const err = await loadRemoteModule({
              remoteName,
              exposedModule: './Component',
            }).catch((e: unknown) => e);

            // Must be a RemoteLoadError (not RemoteNotFoundError or TypeError)
            if (!(err instanceof RemoteLoadError)) return false;

            // remoteName must be non-empty and match the input
            if (!err.remoteName || err.remoteName !== remoteName) return false;

            // url must match what was registered in the manifest
            if (!err.url || err.url !== url) return false;

            // cause must be a non-null Error
            if (err.cause == null || !(err.cause instanceof Error)) return false;

            return true;
          },
        ),
        { numRuns: 20 }, // Limit runs — each run makes a failing network call
      );
    },
  );
});

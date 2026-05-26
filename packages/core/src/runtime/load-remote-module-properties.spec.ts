/**
 * Property-based tests for `loadRemoteModule()` — Properties 1 and 3
 *
 * Property 1: Idempotent Container Loading
 *   Calling `loadRemoteModule` twice with the same `(remoteName, exposedModule)`
 *   returns the same module reference, and the container is loaded only once.
 *   **Validates: Requirements 6.3, 6.4**
 *
 * Property 3: remoteEntry.js Global Registration
 *   After `loadScript(remoteEntryUrl)` resolves, `globalThis.__MF_CONTAINERS__[remoteName]`
 *   is defined and contains the expected container shape.
 *   **Validates: Requirements 6.1, 3.1**
 */

import * as fc from 'fast-check';
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock: intercept dynamicImport so no real network calls happen.
// vi.mock() is hoisted to the top of the file by Vitest's module system.
// ---------------------------------------------------------------------------
vi.mock('./dynamic-import.js', () => ({
  dynamicImport: vi.fn<(url: string) => Promise<unknown>>(),
}));

import { dynamicImport } from './dynamic-import.js';
import { loadRemoteModule, clearContainerCache } from './load-remote-module.js';
import type { RemoteContainer, RemoteManifest } from '../types/index.js';

// Typed reference to the mocked function so we get IDE autocompletion.
const mockDynamicImport = dynamicImport as MockedFunction<typeof dynamicImport>;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Remote names: alphanumeric + hyphens/underscores, starting with a letter.
 * e.g. 'mfe1', 'my-remote', 'shell_app'
 */
const remoteNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);

/**
 * Exposed module paths that start with `'./'`.
 * e.g. './Component', './Module', './routes'
 */
const exposedModuleArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
  .map((s) => `./${s}`);

/**
 * Valid semver version strings: MAJOR.MINOR.PATCH with small ranges.
 */
const semverVersionArb = fc
  .tuple(
    fc.integer({ min: 1, max: 17 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal RemoteContainer with the given name and a single exposed
 * module at `exposedPath`. The exposed factory returns `modulePayload`.
 *
 * @param remoteName  - Container name (must match globalThis key).
 * @param exposedPath - The exposed module path (must start with `./`).
 * @param modulePayload - Object returned by the module factory.
 * @param version     - Semver version string.
 */
function makeContainer(
  remoteName: string,
  exposedPath: string,
  modulePayload: object,
  version = '1.0.0',
): RemoteContainer {
  return {
    name: remoteName,
    version,
    shared: {},
    exposes: {
      [exposedPath]: () => Promise.resolve(modulePayload),
    },
  };
}

/**
 * Register a container in globalThis.__MF_CONTAINERS__ and a matching
 * entry in globalThis.__MF_MANIFEST__, then configure mockDynamicImport so
 * that loading `remoteEntryUrl` is a no-op (the container is already seeded).
 *
 * This simulates what a real `remoteEntry.js` would do when `import()`-ed:
 * it self-registers into `globalThis.__MF_CONTAINERS__`.
 *
 * @returns The remoteEntry URL used in the manifest.
 */
function seedRemoteEnvironment(
  remoteName: string,
  container: RemoteContainer,
): string {
  const url = `https://cdn.example.com/${remoteName}/remoteEntry.js`;

  // Pre-register the container so it's found after mockDynamicImport resolves.
  globalThis.__MF_CONTAINERS__ = {
    ...(globalThis.__MF_CONTAINERS__ ?? {}),
    [remoteName]: container,
  };

  // Register the manifest so loadRemoteModule can resolve the URL.
  globalThis.__MF_MANIFEST__ = {
    ...(globalThis.__MF_MANIFEST__ ?? {}),
    [remoteName]: { remoteEntry: url },
  } as RemoteManifest;

  // Make dynamicImport a no-op (the container is already in __MF_CONTAINERS__).
  mockDynamicImport.mockResolvedValue({});

  return url;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearContainerCache();
  globalThis.__MF_CONTAINERS__ = undefined;
  globalThis.__MF_MANIFEST__ = undefined;
  mockDynamicImport.mockReset();
});

afterEach(() => {
  globalThis.__MF_CONTAINERS__ = undefined;
  globalThis.__MF_MANIFEST__ = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Property 1: Idempotent Container Loading
// **Validates: Requirements 6.3, 6.4**
// ---------------------------------------------------------------------------

describe('Property 1: Idempotent Container Loading', () => {
  it(
    'calling loadRemoteModule twice with the same (remoteName, exposedModule) returns the same module reference',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          remoteNameArb,
          exposedModuleArb,
          semverVersionArb,
          async (remoteName, exposedModule, version) => {
            // ── Reset global state for every generated example ─────────────
            clearContainerCache();
            mockDynamicImport.mockReset();

            // Each run needs a fresh unique module payload so we can check
            // reference identity (same object === same module instance).
            const modulePayload = { component: `${remoteName}-${exposedModule}` };
            const container = makeContainer(remoteName, exposedModule, modulePayload, version);

            seedRemoteEnvironment(remoteName, container);

            // ── First call ─────────────────────────────────────────────────
            const result1 = await loadRemoteModule({ remoteName, exposedModule });

            // ── Second call — container must be served from cache ──────────
            const result2 = await loadRemoteModule({ remoteName, exposedModule });

            // Requirement 6.4: same module reference on repeated calls.
            expect(result1).toBe(result2);

            // Requirement 6.3: dynamicImport (i.e. loadScript) must have been
            // called exactly ONCE — the container is cached after the first load.
            expect(mockDynamicImport).toHaveBeenCalledTimes(1);
            expect(mockDynamicImport).toHaveBeenCalledWith(
              `https://cdn.example.com/${remoteName}/remoteEntry.js`,
            );

            // Clean up for next iteration
            clearContainerCache();
            globalThis.__MF_CONTAINERS__ = undefined;
            globalThis.__MF_MANIFEST__ = undefined;
            mockDynamicImport.mockReset();
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it('concrete example: loadScript called once, module reference is identical', async () => {
    const modulePayload = { default: class RemoteComponent {} };
    const container = makeContainer('mfe1', './Component', modulePayload, '17.0.0');
    seedRemoteEnvironment('mfe1', container);

    const first = await loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' });
    const second = await loadRemoteModule({ remoteName: 'mfe1', exposedModule: './Component' });

    expect(first).toBe(second);
    // loadScript (dynamicImport) called exactly once despite two loadRemoteModule calls
    expect(mockDynamicImport).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Property 3: remoteEntry.js Global Registration
// **Validates: Requirements 6.1, 3.1**
// ---------------------------------------------------------------------------

describe('Property 3: remoteEntry.js Registration', () => {
  it(
    'after loadScript completes, globalThis.__MF_CONTAINERS__[remoteName] is defined with the expected shape',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          remoteNameArb,
          exposedModuleArb,
          semverVersionArb,
          async (remoteName, exposedModule, version) => {
            // ── Reset global state for every generated example ─────────────
            clearContainerCache();
            mockDynamicImport.mockReset();
            globalThis.__MF_CONTAINERS__ = undefined;
            globalThis.__MF_MANIFEST__ = undefined;

            const modulePayload = { component: `${remoteName}-${exposedModule}` };
            const url = `https://cdn.example.com/${remoteName}/remoteEntry.js`;

            // Register the manifest so loadRemoteModule can resolve the URL.
            globalThis.__MF_MANIFEST__ = {
              [remoteName]: { remoteEntry: url },
            } as RemoteManifest;

            // Simulate what a real remoteEntry.js does: it registers the
            // container into globalThis.__MF_CONTAINERS__ as a side-effect of
            // being `import()`-ed.  We replicate that by pre-populating the
            // container INSIDE the mockDynamicImport implementation.
            mockDynamicImport.mockImplementation(async () => {
              // This is the side-effect that remoteEntry.js performs on load.
              globalThis.__MF_CONTAINERS__ = {
                ...(globalThis.__MF_CONTAINERS__ ?? {}),
                [remoteName]: makeContainer(remoteName, exposedModule, modulePayload, version),
              };
              return {};
            });

            // ── Execute load ───────────────────────────────────────────────
            await loadRemoteModule({ remoteName, exposedModule });

            // ── Assert container was registered (Req 6.1, 3.1) ────────────
            const registeredContainer = globalThis.__MF_CONTAINERS__?.[remoteName];

            // Container must exist after script load.
            if (!registeredContainer) return false;

            // Container must have the required shape fields (Req 8.1–8.4).
            if (typeof registeredContainer.name !== 'string') return false;
            if (typeof registeredContainer.version !== 'string') return false;
            if (typeof registeredContainer.exposes !== 'object') return false;
            if (typeof registeredContainer.shared !== 'object') return false;

            // Container name must match the registered key.
            if (registeredContainer.name !== remoteName) return false;

            // The exposed module must be present in the container.
            if (!(exposedModule in registeredContainer.exposes)) return false;

            // Clean up for next iteration
            clearContainerCache();
            globalThis.__MF_CONTAINERS__ = undefined;
            globalThis.__MF_MANIFEST__ = undefined;
            mockDynamicImport.mockReset();

            return true;
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'concrete example: container is registered at globalThis.__MF_CONTAINERS__[remoteName] after load',
    async () => {
      const url = 'https://cdn.example.com/mfe2/remoteEntry.js';
      const container = makeContainer('mfe2', './Module', { ngModule: 'RemoteModule' }, '2.1.0');

      globalThis.__MF_MANIFEST__ = { mfe2: { remoteEntry: url } } as RemoteManifest;

      // Simulate remoteEntry.js registering the container as a side-effect.
      mockDynamicImport.mockImplementation(async () => {
        globalThis.__MF_CONTAINERS__ = { mfe2: container };
        return {};
      });

      await loadRemoteModule({ remoteName: 'mfe2', exposedModule: './Module' });

      // Container must be registered with correct shape.
      const registered = globalThis.__MF_CONTAINERS__?.['mfe2'];
      expect(registered).toBeDefined();
      expect(registered?.name).toBe('mfe2');
      expect(registered?.version).toBe('2.1.0');
      expect(registered?.exposes).toHaveProperty('./Module');
      expect(registered?.shared).toBeDefined();

      // dynamicImport must have been called with the manifest URL.
      expect(mockDynamicImport).toHaveBeenCalledWith(url);
    },
  );
});

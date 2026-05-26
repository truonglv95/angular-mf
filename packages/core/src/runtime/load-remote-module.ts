/**
 * loadRemoteModule — Algorithm 3
 *
 * Dynamically loads an exposed module from a remote Module Federation
 * container by:
 *   1. Validating the `exposedModule` argument format
 *   2. Resolving the `remoteEntry` URL from config or manifest
 *   3. Loading and caching the remote container script (once per remote)
 *   4. Negotiating all shared dependencies
 *   5. Calling the exposed module factory and returning the result
 *
 * Security contract (Req 11.1, 11.2):
 *   - Only native `import()` is used — never `eval()` or `new Function()`.
 *   - Remote URLs not present in the manifest are allowed with a warning for
 *     now. Full `allowDynamicRemotes` enforcement is handled in the security
 *     layer (see task 9.2/9.3).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 11.1, 11.2
 */

import type { RemoteContainer, RemoteModuleConfig } from '../types/index.js';
import {
  ExposedModuleNotFoundError,
  RemoteContainerInitError,
  RemoteLoadError,
  RemoteNotFoundError,
} from '../errors.js';
import { negotiateSharedDependency } from './negotiate-shared-dependency.js';
import { dynamicImport } from './dynamic-import.js';

// ---------------------------------------------------------------------------
// Module-level container cache
// ---------------------------------------------------------------------------

/**
 * Cache of successfully initialised remote containers, keyed by remoteName.
 *
 * Once a container is cached, subsequent `loadRemoteModule()` calls for the
 * same `remoteName` skip the network fetch entirely (Req 6.3, 12.2).
 */
const loadedContainers = new Map<string, RemoteContainer>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load a remote entry script via native ESM dynamic `import()`.
 *
 * Security (Req 11.2): Only `import()` is used here — `eval()` and
 * `new Function()` are explicitly forbidden by the security requirements.
 *
 * @param remoteName - Name of the remote (used in error messages only).
 * @param url        - Absolute URL of the `remoteEntry.js` to load.
 * @throws {RemoteLoadError} When the dynamic import rejects for any reason
 *   (network error, CORS, 404, etc.) — Req 6.7, 9.1.
 */
async function loadScript(remoteName: string, url: string): Promise<void> {
  try {
    // Req 11.2 — native dynamic import(); no eval() / new Function() allowed.
    // Delegates to the thin dynamicImport() wrapper so tests can mock it
    // without touching production security semantics.
    await dynamicImport(url);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new RemoteLoadError(remoteName, url, cause);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dynamically load an exposed module from a remote Module Federation container.
 *
 * **Algorithm 3 — step-by-step:**
 *
 * 1. Validate `config.exposedModule` starts with `'./'` (Req 6.10).
 * 2. Resolve the `remoteEntry` URL:
 *    - Use `config.remoteEntry` if provided (Req 6.5).
 *    - Fall back to `globalThis.__MF_MANIFEST__[config.remoteName].remoteEntry`.
 *    - Throw `RemoteNotFoundError` if neither is available (Req 6.6).
 * 3. Security check: warn if the resolved URL is not in the manifest (Req 11.1).
 * 4. Check `loadedContainers` cache — skip to step 8 if already loaded (Req 6.3).
 * 5. Load the remote script with `loadScript()` via `import()` (Req 11.2).
 * 6. Assert `globalThis.__MF_CONTAINERS__[remoteName]` was registered (Req 6.8).
 * 7. Negotiate all shared dependencies (Req 6.2).
 *    Cache the container in `loadedContainers` (Req 6.3).
 * 8. Resolve `container.exposes[config.exposedModule]` (Req 6.9).
 * 9. Call and return `moduleFactory()` as `Promise<T>` (Req 6.1, 6.4).
 *
 * @param config - Remote module load configuration.
 * @returns A `Promise` that resolves to the exported module `T`.
 *
 * @throws {TypeError} When `config.exposedModule` does not start with `'./'`.
 * @throws {RemoteNotFoundError} When the remote is not in the manifest and no
 *   `config.remoteEntry` override is provided.
 * @throws {RemoteLoadError} When the remote entry script fails to load.
 * @throws {RemoteContainerInitError} When the script loads but does not
 *   register a container at `globalThis.__MF_CONTAINERS__[remoteName]`.
 * @throws {ExposedModuleNotFoundError} When the exposed module path is not in
 *   the container's `exposes` map.
 *
 * Preconditions:
 *  - `config.remoteName` is in the manifest OR `config.remoteEntry` is provided.
 *  - `config.exposedModule` starts with `'./'`.
 *
 * Postconditions:
 *  - Returns the lazy-loaded module `T`.
 *  - The container is cached in `loadedContainers`; subsequent calls for the
 *    same `remoteName` skip the network fetch.
 *  - All shared dependencies for the remote are negotiated.
 */
export async function loadRemoteModule<T = unknown>(
  config: RemoteModuleConfig,
): Promise<T> {
  // ── Step 1: Validate exposedModule format ─────────────────────────────────
  // Requirement 6.10 — must start with './'
  if (!config.exposedModule.startsWith('./')) {
    throw new TypeError(
      `[MF] loadRemoteModule: "exposedModule" must start with "./" but got "${config.exposedModule}"`,
    );
  }

  // ── Step 2: Resolve remoteEntry URL ──────────────────────────────────────
  // Requirement 6.5 — use config.remoteEntry override if provided.
  // Requirement 6.6 — throw RemoteNotFoundError if no URL can be found.
  const manifestEntry = (globalThis.__MF_MANIFEST__ ?? {})[config.remoteName];
  const remoteEntryUrl = config.remoteEntry ?? manifestEntry?.remoteEntry;

  if (!remoteEntryUrl) {
    throw new RemoteNotFoundError(config.remoteName);
  }

  // ── Step 3: Security check — dynamic remote URL not in manifest ───────────
  // Requirement 11.1 — the runtime SHOULD only load URLs listed in the manifest.
  //
  // TODO (task 9.2/9.3): When the security layer is implemented, this block
  // should throw when `allowDynamicRemotes !== true` instead of only warning.
  // For now we log a warning to surface the constraint without breaking
  // development workflows.
  if (config.remoteEntry && !manifestEntry) {
    console.warn(
      `[MF] Security warning (Req 11.1): Remote "${config.remoteName}" is being ` +
      `loaded from "${config.remoteEntry}" which is NOT registered in ` +
      `globalThis.__MF_MANIFEST__. ` +
      `In a future release this will throw unless allowDynamicRemotes: true is set.`,
    );
  }

  // ── Step 4: Check container cache ────────────────────────────────────────
  // Requirement 6.3, 12.2 — serve from cache to avoid duplicate network requests.
  let container = loadedContainers.get(config.remoteName);

  if (!container) {
    // ── Step 5: Load remote script ──────────────────────────────────────────
    // Requirement 6.1 — fetch and execute remoteEntry.js.
    // Requirement 11.2 — native import() only; no eval() / new Function().
    await loadScript(config.remoteName, remoteEntryUrl);

    // ── Step 6: Assert container was registered ─────────────────────────────
    // Requirement 6.8 — throw RemoteContainerInitError if container is absent.
    const registeredContainer =
      globalThis.__MF_CONTAINERS__?.[config.remoteName];

    if (!registeredContainer) {
      const registeredNames = Object.keys(
        globalThis.__MF_CONTAINERS__ ?? {},
      ).join(', ') || '(none)';
      throw new RemoteContainerInitError(
        config.remoteName,
        `Registered containers after script load: [${registeredNames}]`,
      );
    }

    // ── Step 7: Negotiate shared dependencies ───────────────────────────────
    // Requirement 6.2 — negotiate ALL shared deps before instantiating modules.
    //
    // FIX: Previously the negotiation result was discarded. Now we:
    //   1. Use the result to determine which factory wins (host vs remote).
    //   2. Update globalThis.__MF_SHARED__ so that:
    //      a) Subsequent bare imports (e.g. import('@angular/core')) inside
    //         remote chunks resolve via the winning factory.
    //      b) Later remotes loaded in the same session reuse the already-
    //         negotiated instance instead of creating a new one.
    //
    // This is the equivalent of Webpack MF's container.init(sharedScope).
    //
    // Loop invariant: every package processed in a prior iteration has been
    // fully negotiated and registered in the host scope before the next
    // iteration begins.
    globalThis.__MF_SHARED__ = globalThis.__MF_SHARED__ ?? {};

    for (const [pkgName, sharedDep] of Object.entries(
      registeredContainer.shared,
    )) {
      const negotiation = await negotiateSharedDependency(
        pkgName,
        String(sharedDep.version),
        sharedDep,
      );

      // Register the winning factory back into __MF_SHARED__ so that:
      //   • The remote's bare imports resolve to the correct instance.
      //   • Later remotes see this entry and reuse the same instance.
      //
      // Only update if:
      //   - Host didn't have this dep (resolved: 'remote') — register remote's factory.
      //   - Non-singleton incompatible (resolved: 'new-instance') — remote loads its own.
      //   - Host already had it (resolved: 'host') — __MF_SHARED__ already correct, skip.
      if (negotiation.resolved === 'remote' || negotiation.resolved === 'new-instance') {
        globalThis.__MF_SHARED__[pkgName] = {
          version: negotiation.providedVersion,
          singleton: negotiation.singleton,
          factory: negotiation.factory,
        };
      }
    }

    // Cache the fully-initialised container (Req 6.3).
    loadedContainers.set(config.remoteName, registeredContainer);
    container = registeredContainer;
  }

  // ── Step 8: Resolve exposed module factory ───────────────────────────────
  // Requirement 6.9 — throw ExposedModuleNotFoundError when path is absent.
  const moduleFactory = container.exposes[config.exposedModule];

  if (!moduleFactory) {
    throw new ExposedModuleNotFoundError(
      config.remoteName,
      config.exposedModule,
    );
  }

  // ── Step 9: Call and return the factory ──────────────────────────────────
  // Requirement 6.1, 6.4 — return the module; repeated calls return the same
  // reference because the container is cached and the factory is idempotent.
  //
  // Wrap in Promise.resolve().then() so that any synchronous throw from the
  // factory (before its first await) is converted to a rejected Promise rather
  // than propagating as an uncaught synchronous exception to the caller.
  return Promise.resolve().then(() => moduleFactory()) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Test utility
// ---------------------------------------------------------------------------

/**
 * Clear the internal container cache.
 *
 * **For testing only.** Resets the `loadedContainers` map so that unit tests
 * can exercise the full loading path in isolation without cross-test pollution.
 *
 * Do **not** call this in production code.
 */
export function clearContainerCache(): void {
  loadedContainers.clear();
}

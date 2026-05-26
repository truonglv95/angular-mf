/**
 * generateRemoteEntry — Algorithm 1 from the design document.
 *
 * Generates the JavaScript source for `remoteEntry.js` that registers a
 * RemoteContainer at `globalThis.__MF_CONTAINERS__[name]`.
 *
 * Requirements: 3.1, 3.3, 3.5, 3.6, 3.8, 8.1, 8.2, 8.3, 8.4
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processSharedDependencies } from './process-shared-dependencies.js';
import type { ModuleFederationConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Version resolver
// ---------------------------------------------------------------------------

/**
 * Reads the application's `version` field from `package.json` in
 * `process.cwd()`. Falls back to `'0.0.0'` when the file is absent or
 * cannot be parsed.
 *
 * The result is used to populate the `version` field of the RemoteContainer
 * (Requirement 3.8).
 *
 * @returns Resolved version string (always a valid semver string).
 */
export async function resolveVersion(): Promise<string> {
  // Walk up from process.cwd() to find the nearest package.json that has
  // a 'version' field. This handles monorepos where:
  //   - process.cwd() is the workspace root (no version or wrong version)
  //   - The actual project package.json lives in packages/<name>/
  //
  // We stop at the filesystem root to avoid infinite loops.
  const { dirname } = await import('node:path');
  let dir = process.cwd();
  const root = dirname(dir); // stop one level above root guard

  while (dir !== root) {
    try {
      const pkgPath = join(dir, 'package.json');
      const raw = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: unknown; name?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // No package.json here or unreadable — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Final fallback
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// Remote entry generator
// ---------------------------------------------------------------------------

/**
 * Generates the JavaScript source string for `remoteEntry.js`.
 *
 * **Algorithm 1 implementation:**
 * 1. Iterate `config.exposes` and build `exposedEntries` with async import factories.
 *    Each entry takes the form: `"./Key": async () => import("<chunkUrl>")`
 * 2. Call `processSharedDependencies(config.shared ?? {})` to obtain shared entries.
 * 3. Assemble the `__mf_container__` object literal.
 * 4. Register the container on `globalThis.__MF_CONTAINERS__`.
 * 5. Return the complete JavaScript string.
 *
 * **Preconditions:**
 * - `config.name` is non-empty (validated by `withModuleFederation()`).
 * - `config.exposes` has at least one entry.
 * - `buildOutputs` contains compiled chunk URLs for all source paths in
 *   `config.exposes`.
 *
 * **Postconditions:**
 * - The returned string is valid JavaScript (ES2020+).
 * - When executed, the script registers a RemoteContainer at
 *   `globalThis.__MF_CONTAINERS__[config.name]`.
 * - Every key in `config.exposes` is present in the container's `exposes` map.
 *
 * @param config       - Validated `ModuleFederationConfig` for this remote app.
 * @param buildOutputs - Map of source file path → compiled chunk URL/filename
 *                       produced by the bundler (esbuild / Vite).
 * @returns Promise resolving to the generated `remoteEntry.js` source string.
 *
 * Requirements: 3.1, 3.3, 3.5, 3.6, 3.8, 8.1, 8.2, 8.3, 8.4
 */
export async function generateRemoteEntry(
  config: ModuleFederationConfig,
  buildOutputs: Map<string, string>,
): Promise<string> {
  // -------------------------------------------------------------------------
  // Step 1: Build exposed module entries
  //
  // CRITICAL FIX: Use import.meta.url-based absolute URL resolution.
  //
  // Problem: If chunkUrl is a relative path like "./GreetingComponent-HASH.js",
  // the dynamic import() inside remoteEntry.js resolves it relative to the
  // HOST page URL (e.g. http://host:4200/), NOT the remote server URL
  // (e.g. http://remote:4202/). This causes a 404 because the chunk only
  // exists on the remote server.
  //
  // Fix: Inject a `__mf_base__` variable computed from `import.meta.url` at the
  // top of remoteEntry.js. All exposed chunk imports use this base to construct
  // absolute URLs. `import.meta.url` of remoteEntry.js is always the remote
  // server URL (e.g. "http://remote:4202/remoteEntry.js"), so stripping the
  // filename gives the correct base for all sibling chunks.
  //
  // Loop invariant: every `exposedPath` starts with './' (enforced by
  // `withModuleFederation()` / `asExposedPath()`).
  // -------------------------------------------------------------------------
  const exposedEntries: string[] = [];

  for (const [exposedPath, sourcePath] of Object.entries(config.exposes ?? {})) {
    // Resolve the compiled chunk URL from the build outputs map.
    // Fall back to the source path itself when no mapping is found (e.g. in
    // unit tests that pass a minimal buildOutputs map).
    const chunkFilename = buildOutputs.get(sourcePath) ?? sourcePath;

    // Strip leading "./" to get just the filename (e.g. "GreetingComponent-HASH.js")
    // The runtime __mf_base__ will provide the correct absolute origin prefix.
    const bareFilename = chunkFilename.startsWith('./') ? chunkFilename.slice(2) : chunkFilename;

    // Use new URL() to construct absolute URL from the base at runtime.
    // This is safe in all modern browsers and Node ESM contexts.
    exposedEntries.push(`"${exposedPath}": async () => import(new URL("${bareFilename}", __mf_base__).href)`);
  }

  // -------------------------------------------------------------------------
  // Step 2: Process shared dependencies (delegates to shared utility)
  // -------------------------------------------------------------------------

  // Resolve shared config: when it is a function, it has already been called
  // by `withModuleFederation()` before this point. Defensively handle the
  // raw-object case here as well.
  const resolvedShared =
    typeof config.shared === 'function' ? config.shared({}) : (config.shared ?? {});

  const sharedEntries = processSharedDependencies(resolvedShared);

  // -------------------------------------------------------------------------
  // Step 3: Resolve application version (Req 3.8, 8.2)
  // -------------------------------------------------------------------------
  const version = await resolveVersion();

  // -------------------------------------------------------------------------
  // Step 4 & 5: Assemble container and register on globalThis
  // -------------------------------------------------------------------------

  // NOTE: The target size of remoteEntry.js is < 5 KB gzip (Req 3.7).
  //
  // __mf_base__: Compute the base URL from import.meta.url of THIS file
  // (remoteEntry.js). This gives us "http://remote:4202/" regardless of where
  // the host page is served from. All exposed chunk imports use this base.
  const remoteEntry = `
const __mf_base__ = new URL(".", import.meta.url).href;
const __mf_container__ = {
  name: "${config.name}",
  version: "${version}",
  shared: { ${sharedEntries.join(', ')} },
  exposes: { ${exposedEntries.join(', ')} }
};
globalThis.__MF_CONTAINERS__ = globalThis.__MF_CONTAINERS__ ?? {};
globalThis.__MF_CONTAINERS__["${config.name}"] = __mf_container__;
`.trimStart();

  // Postcondition: remoteEntry is valid JavaScript that registers the
  // container at globalThis.__MF_CONTAINERS__[config.name].
  return remoteEntry;
}

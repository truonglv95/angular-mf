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
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
    return '0.0.0';
  } catch {
    // File not found, permission error, or invalid JSON — use safe default.
    return '0.0.0';
  }
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
  // Loop invariant: every `exposedPath` starts with './' (enforced by
  // `withModuleFederation()` / `asExposedPath()`).
  // -------------------------------------------------------------------------
  const exposedEntries: string[] = [];

  for (const [exposedPath, sourcePath] of Object.entries(config.exposes ?? {})) {
    // Resolve the compiled chunk URL from the build outputs map.
    // Fall back to the source path itself when no mapping is found (e.g. in
    // unit tests that pass a minimal buildOutputs map).
    const chunkUrl = buildOutputs.get(sourcePath) ?? sourcePath;

    // Each entry is a property in the `exposes` object of the container.
    exposedEntries.push(`"${exposedPath}": async () => import("${chunkUrl}")`);
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
  // Keep generated code minimal: no helper functions, no runtime imports —
  // just a plain object literal + two assignment statements.
  const remoteEntry = `
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

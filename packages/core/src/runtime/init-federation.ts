/**
 * initFederation — Runtime bootstrap helper
 *
 * Loads the remote manifest and registers it at `globalThis.__MF_MANIFEST__`
 * so that subsequent `loadRemoteModule()` calls can resolve remote entry URLs.
 *
 * Accepts either:
 *  - A URL string — fetches the JSON manifest file from the network.
 *  - A `RemoteManifest` object — registers it directly without any network call.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import type { RemoteManifest } from '../types/index.js';

/**
 * Bootstrap Module Federation by registering the remote manifest.
 *
 * @param manifest - Either a URL string pointing to a `manifest.json` file, or
 *                   a pre-loaded `RemoteManifest` object.
 * @returns A Promise that resolves once `globalThis.__MF_MANIFEST__` has been
 *          populated. After resolution, all `loadRemoteModule()` calls can look
 *          up remote entry URLs from the registered manifest.
 *
 * @throws If `manifest` is a URL string:
 *   - Network / connection failure:
 *     `[MF] initFederation: Failed to fetch manifest from "<url>": <cause>`
 *   - HTTP error (response.ok === false):
 *     `[MF] initFederation: Failed to fetch manifest from "<url>": HTTP <status> <statusText>`
 *   - Non-JSON body:
 *     `[MF] initFederation: Manifest at "<url>" is not valid JSON: <cause>`
 *
 * Preconditions:
 *  - If `manifest` is a string, it must be a URL reachable at call time.
 *  - If `manifest` is an object, it must conform to `RemoteManifest`.
 *
 * Postconditions:
 *  - `globalThis.__MF_MANIFEST__` contains all entries from the manifest.
 *  - Every remote name in the manifest maps to the exact same `remoteEntry` URL
 *    that was present in the original manifest (round-trip guarantee).
 */
export async function initFederation(
  manifest: RemoteManifest | string,
): Promise<void> {
  // ── Branch A: manifest is already an object — register directly ──────────
  // Requirement 5.2 — no network call when an object is provided.
  if (typeof manifest !== 'string') {
    globalThis.__MF_MANIFEST__ = manifest;
    return;
  }

  // ── Branch B: manifest is a URL string — fetch and parse ─────────────────
  const url = manifest;

  // Step 1: Fetch the manifest JSON.
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err: unknown) {
    // Network error / DNS failure / CORS / etc.
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[MF] initFederation: Failed to fetch manifest from "${url}": ${cause}`,
    );
  }

  // Step 2: Verify the HTTP response status.
  // Requirement 5.4 — reject with descriptive error when response is not ok.
  if (!response.ok) {
    throw new Error(
      `[MF] initFederation: Failed to fetch manifest from "${url}": HTTP ${response.status} ${response.statusText}`,
    );
  }

  // Step 3: Parse the response body as JSON.
  // Requirement 5.4 — reject when response body is not valid JSON.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[MF] initFederation: Manifest at "${url}" is not valid JSON: ${cause}`,
    );
  }

  // Step 4: Validate that the parsed result is a plain object.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `[MF] initFederation: Manifest at "${url}" is not valid JSON: expected an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }

  // Step 5: Register the manifest.
  // Requirement 5.3 — populate globalThis.__MF_MANIFEST__ with the result.
  globalThis.__MF_MANIFEST__ = parsed as RemoteManifest;
}

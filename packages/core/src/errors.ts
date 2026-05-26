/**
 * Custom error classes for @angular-mf/esbuild Module Federation runtime.
 *
 * Each class extends Error and sets `this.name` to the class name for
 * reliable `instanceof` checks and stack trace readability.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

/**
 * Thrown when a remote app's `remoteEntry.js` cannot be fetched.
 * Contains the remote name, the attempted URL, and the underlying cause.
 *
 * Requirement 9.1
 */
export class RemoteLoadError extends Error {
  override readonly name = 'RemoteLoadError';

  constructor(
    public readonly remoteName: string,
    public readonly url: string,
    public readonly cause: Error,
  ) {
    super(
      `[MF] Failed to load remote "${remoteName}" from "${url}": ${cause.message}`,
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when the requested remote is not registered in the manifest and
 * no `remoteEntry` override is provided in the load call.
 *
 * Requirement 6.6
 */
export class RemoteNotFoundError extends Error {
  override readonly name = 'RemoteNotFoundError';

  constructor(public readonly remoteName: string) {
    super(
      `[MF] Remote "${remoteName}" not found in manifest and no remoteEntry provided`,
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when a `remoteEntry.js` executes but does not register a valid
 * RemoteContainer at `globalThis.__MF_CONTAINERS__[remoteName]`.
 * Carries optional diagnostic info about the expected vs. actual shape.
 *
 * Requirement 9.4
 */
export class RemoteContainerInitError extends Error {
  override readonly name = 'RemoteContainerInitError';

  constructor(
    public readonly remoteName: string,
    public readonly diagnostics?: string,
  ) {
    const base = `[MF] Remote "${remoteName}" did not register a valid container at globalThis.__MF_CONTAINERS__["${remoteName}"]`;
    const detail = diagnostics
      ? `. Expected: { name, version, exposes, shared }. Actual: ${diagnostics}`
      : `. Expected: { name, version, exposes, shared }`;

    super(`${base}${detail}`);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when the requested `exposedModule` path is not present in the
 * RemoteContainer's `exposes` map.
 *
 * Requirement 9.3
 */
export class ExposedModuleNotFoundError extends Error {
  override readonly name = 'ExposedModuleNotFoundError';

  constructor(
    public readonly remoteName: string,
    public readonly exposedPath: string,
  ) {
    super(
      `[MF] Remote "${remoteName}" does not expose "${exposedPath}"`,
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when a strict singleton version mismatch is detected: the remote
 * requires a semver range that is incompatible with the host-provided version.
 *
 * Requirement 9.2
 */
export class SharedVersionMismatchError extends Error {
  override readonly name = 'SharedVersionMismatchError';

  constructor(
    public readonly packageName: string,
    public readonly requiredVersion: string,
    public readonly providedVersion: string,
  ) {
    super(
      `[MF] Singleton "${packageName}" version mismatch: remote requires "${requiredVersion}", host provides "${providedVersion}"`,
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when Subresource Integrity (SRI) verification fails — the hash of
 * the downloaded `remoteEntry.js` does not match the expected hash in the
 * manifest.
 *
 * Requirements 11.3, 11.4
 */
export class MfIntegrityError extends Error {
  override readonly name = 'MfIntegrityError';

  constructor(
    public readonly remoteName: string,
    public readonly url: string,
    public readonly expectedHash: string,
  ) {
    super(
      `[MF] Integrity check failed for remote "${remoteName}" at "${url}": ` +
      `script hash does not match expected SRI hash "${expectedHash}"`,
    );

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

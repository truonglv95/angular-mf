/**
 * @angular-mf/esbuild — Shared TypeScript interfaces and data models
 *
 * This module defines all public-facing types used across the package:
 * builder options, plugin options, runtime contracts, and negotiation models.
 */

// ---------------------------------------------------------------------------
// Branded primitive types
// ---------------------------------------------------------------------------

/**
 * A file-system path used in Module Federation `exposes` maps.
 * Must start with `./` (e.g. `'./Component'`, `'./Module'`).
 *
 * @example
 * const path = asExposedPath('./Component'); // OK
 * const bad  = asExposedPath('Component');   // throws at runtime
 */
declare const ExposedPathBrand: unique symbol;
export type ExposedPath = string & { readonly [ExposedPathBrand]: typeof ExposedPathBrand };

/**
 * A semantic-version string conforming to the semver specification
 * (e.g. `'17.0.0'`, `'^17.0.0'`, `'~16.2.3'`).
 *
 * @example
 * const v = asSemverString('17.0.0'); // OK
 */
declare const SemverStringBrand: unique symbol;
export type SemverString = string & { readonly [SemverStringBrand]: typeof SemverStringBrand };

// Runtime helpers for constructing branded values.

/**
 * Asserts and casts a string to {@link ExposedPath}.
 * @throws {TypeError} If the string does not start with `./`.
 */
export function asExposedPath(value: string): ExposedPath {
  if (!value.startsWith('./')) {
    throw new TypeError(
      `[MF] ExposedPath must start with './', got: "${value}"`
    );
  }
  return value as ExposedPath;
}

/**
 * Casts a string to {@link SemverString} without runtime validation.
 * The caller is responsible for ensuring the string is a valid semver expression.
 */
export function asSemverString(value: string): SemverString {
  return value as SemverString;
}

// ---------------------------------------------------------------------------
// Shared library / dependency configuration
// ---------------------------------------------------------------------------

/**
 * Per-package configuration for a shared dependency in the Module Federation
 * container. All fields are optional to allow partial overrides.
 */
export interface SharedLibraryConfig {
  /** When `true`, only one instance of this package is allowed across all remotes. */
  singleton?: boolean;
  /**
   * When `true` (and `singleton` is `true`), a version incompatibility will
   * throw a {@link SharedVersionMismatchError} instead of silently using the
   * host version.
   */
  strictVersion?: boolean;
  /**
   * Semver range required by this consumer (e.g. `'^17.0.0'`).
   * Used during version negotiation.
   */
  requiredVersion?: SemverString | string;
  /**
   * When `true`, the shared module is included in the initial chunk instead
   * of being lazy-loaded. Use sparingly — eager sharing increases initial
   * bundle size.
   */
  eager?: boolean;
  /** Exact version provided / available from this build. */
  version?: SemverString | string;
}

/**
 * Map of npm package name → {@link SharedLibraryConfig}.
 *
 * @example
 * const shared: SharedConfig = {
 *   '@angular/core':   { singleton: true, strictVersion: true },
 *   '@angular/common': { singleton: true },
 * };
 */
export type SharedConfig = Record<string, SharedLibraryConfig>;

// ---------------------------------------------------------------------------
// Remote definition
// ---------------------------------------------------------------------------

/**
 * Explicit remote definition when a plain URL string is insufficient.
 *
 * @example
 * const remote: RemoteDefinition = { type: 'module', url: 'http://localhost:4201/remoteEntry.js' };
 */
export interface RemoteDefinition {
  /** `'module'` — ESM remote entry; `'script'` — classic script remote entry. */
  type: 'module' | 'script';
  /** Absolute URL to the remote app's entry file. */
  url: string;
}

// ---------------------------------------------------------------------------
// Module Federation configuration
// ---------------------------------------------------------------------------

/**
 * Declarative configuration for a single Module Federation participant
 * (host, remote, or both).
 *
 * Consumed by `withModuleFederation()` which validates and normalises the
 * config before passing it to the build and runtime layers.
 */
export interface ModuleFederationConfig {
  /**
   * Unique application identifier within the MF topology.
   * Must be non-empty and contain no whitespace characters.
   * Only alphanumeric characters, hyphens (`-`), and underscores (`_`) are
   * permitted (validated at runtime by `withModuleFederation()`).
   */
  name: string;
  /**
   * Output filename for the generated remote entry.
   * Defaults to `'remoteEntry.js'` when omitted.
   */
  filename?: string;
  /**
   * Map of exposed module paths to their source file paths.
   * Each key MUST start with `'./'`.
   *
   * @example
   * exposes: { './Component': './src/app/remote-entry/entry.component.ts' }
   */
  exposes?: Record<ExposedPath | string, string>;
  /**
   * Map of remote application names to their entry URLs or
   * {@link RemoteDefinition} objects.
   */
  remotes?: Record<string, string | RemoteDefinition>;
  /**
   * Shared dependency configuration. Accepts either:
   * - A static `SharedConfig` object, **or**
   * - A function that receives the auto-detected Angular peer-dep defaults
   *   and returns the final `SharedConfig`.
   */
  shared?: SharedConfig | ((defaults: SharedConfig) => SharedConfig);
}

// ---------------------------------------------------------------------------
// Plugin option interfaces
// ---------------------------------------------------------------------------

/**
 * Options accepted by the esbuild Module Federation plugin
 * (`createEsbuildMfPlugin()`).
 */
export interface EsbuildMfPluginOptions {
  /** Unique application name — same as `ModuleFederationConfig.name`. */
  name: string;
  /** Remote entry output filename (e.g. `'remoteEntry.js'`). */
  filename: string;
  /**
   * Map of exposed path keys (starting with `'./'`) to their source files.
   */
  exposes: Record<ExposedPath | string, string>;
  /** Resolved shared dependency configuration. */
  shared: SharedConfig;
  /** Build mode for the plugin. */
  mode: 'remote' | 'host' | 'both';
  /** Optional browser entry point, used to inject virtual module */
  browser?: unknown;
  /** Absolute path to the final browser output directory (e.g. dist/project/browser).
   *  Used by onEnd to write remoteEntry.js to the correct location. */
  outputPath?: string;
  /**
   * When `true`, the plugin runs inside a Vite dev server.
   * - Dev mode  : rewrites shared imports to `/mf-shared/<pkg>.js` (served by our middleware).
   * - Prod mode : marks shared deps as `build.initialOptions.external` so esbuild leaves bare
   *               ESM imports in the output; the host later injects an import-map to resolve them.
   */
  isDev?: boolean;
}

/**
 * Options accepted by the Vite development server Module Federation plugin
 * (`createViteMfPlugin()`).
 */
export interface ViteMfPluginOptions {
  /** Unique application name — same as `ModuleFederationConfig.name`. */
  name: string;
  /** Remote entry virtual module filename (e.g. `'remoteEntry.js'`). */
  filename: string;
  /**
   * Map of exposed path keys (starting with `'./'`) to their source files.
   */
  exposes: Record<ExposedPath | string, string>;
  /** Resolved shared dependency configuration. */
  shared: SharedConfig;
  /** Build / serve mode for the plugin. */
  mode: 'remote' | 'host' | 'both';
  /**
   * Port on which the Vite dev server should listen.
   * When set, overrides the default Vite port for MF remote serving.
   */
  devPort?: number;
}

// ---------------------------------------------------------------------------
// Angular Builder options
// ---------------------------------------------------------------------------

/**
 * Options for the `@angular-mf/esbuild:application` Angular CLI builder.
 *
 * Extends the standard `ApplicationBuilderOptions` from
 * `@angular-devkit/build-angular` with one additional field. All native
 * options are forwarded unmodified to the underlying builder.
 */
export interface MfBuilderOptions {
  /**
   * Path to the Module Federation config file, relative to the project root.
   * Defaults to `'mf.config.ts'` when omitted.
   */
  mfConfig?: string;
  /**
   * All remaining Angular ApplicationBuilder options are accepted via index
   * signature to avoid a hard compile-time dependency on
   * `@angular-devkit/build-angular` in consumers that only use the types.
   * The concrete builder implementation casts to `ApplicationBuilderOptions`.
   */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Runtime loader types
// ---------------------------------------------------------------------------

/**
 * Configuration passed to `loadRemoteModule()` to identify which remote
 * module should be dynamically loaded.
 */
export interface RemoteModuleConfig {
  /** Name of the remote application (must match the key in the manifest). */
  remoteName: string;
  /**
   * Path of the exposed module within the remote container.
   * Must start with `'./'` (e.g. `'./Component'`).
   */
  exposedModule: ExposedPath | string;
  /**
   * Optional override URL for the remote entry script.
   * When provided, this URL is used instead of the manifest entry for the
   * given `remoteName`.
   */
  remoteEntry?: string;
}

/**
 * JSON manifest that maps remote application names to their entry URLs and
 * optional SRI integrity hashes.
 *
 * Loaded once at application startup via `initFederation()` and stored in
 * `globalThis.__MF_MANIFEST__`.
 *
 * @example
 * {
 *   "mfe1": { "remoteEntry": "http://localhost:4201/remoteEntry.js" },
 *   "mfe2": { "remoteEntry": "https://cdn.example.com/mfe2/remoteEntry.js", "integrity": "sha256-..." }
 * }
 */
export type RemoteManifest = Record<
  string,
  { remoteEntry: string; integrity?: string }
>;

// ---------------------------------------------------------------------------
// Runtime container contracts
// ---------------------------------------------------------------------------

/**
 * Map of npm package name to the shared dependency entry exposed by a
 * remote container.
 *
 * Used by the runtime to negotiate dependency versions before instantiating
 * exposed modules.
 */
export type SharedDependencyMap = {
  [packageName: string]: {
    /** Exact version provided by this remote. */
    version: SemverString | string;
    /** Whether this package is a singleton (only one instance allowed). */
    singleton: boolean;
    /** Whether a version incompatibility should throw rather than warn. */
    strictVersion: boolean;
    /**
     * Async factory that returns the module's exports.
     * Called only if the runtime decides to use the remote's own instance.
     */
    get: () => Promise<unknown>;
  };
};

/**
 * Map of exposed path (starting with `'./'`) to an async factory function
 * that returns the corresponding module.
 */
export type ExposedModuleMap = {
  [exposedPath: ExposedPath | string]: () => Promise<unknown>;
};

/**
 * Runtime representation of a Module Federation remote container.
 *
 * After `remoteEntry.js` executes, a `RemoteContainer` is registered at
 * `globalThis.__MF_CONTAINERS__[name]`.
 */
export interface RemoteContainer {
  /**
   * Unique application name — alphanumeric, hyphens, or underscores only.
   * Must match `ModuleFederationConfig.name`.
   */
  name: string;
  /**
   * Exact semver version of the remote application derived from its
   * `package.json` at build time.
   */
  version: SemverString | string;
  /** All shared dependencies declared by this remote. */
  shared: SharedDependencyMap;
  /** All modules exposed by this remote. */
  exposes: ExposedModuleMap;
}

// ---------------------------------------------------------------------------
// Shared dependency negotiation result
// ---------------------------------------------------------------------------

/**
 * Result of the shared dependency version negotiation algorithm.
 *
 * Describes how a specific shared package was resolved between the host and a
 * remote app.
 */
export interface SharedDependencyNegotiation {
  /**
   * Semver range requested by the remote (from the remote container's
   * `shared` map).
   */
  requestedVersion: SemverString | string;
  /** Exact version that will actually be used (from host or remote). */
  providedVersion: SemverString | string;
  /**
   * Resolution strategy applied:
   * - `'host'`         — host's existing instance is used.
   * - `'remote'`       — remote's own factory is used (host has no entry).
   * - `'new-instance'` — a fresh instance is loaded from the remote (non-singleton, incompatible).
   */
  resolved: 'host' | 'remote' | 'new-instance';
  /** Whether the package was configured as a singleton. */
  singleton: boolean;
  /**
   * Async factory that produces the resolved module.
   * Points to the host factory (`resolved: 'host'`) or the remote factory
   * (`resolved: 'remote'` / `'new-instance'`).
   */
  factory: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Build manifest
// ---------------------------------------------------------------------------

/**
 * Manifest emitted alongside `remoteEntry.js` at build time.
 *
 * Contains metadata about the remote build for tooling, debugging, and
 * optional integrity verification.
 */
export interface BuildManifest {
  /** Application name — same as `ModuleFederationConfig.name`. */
  name: string;
  /** Output filename of the remote entry (e.g. `'remoteEntry.js'`). */
  filename: string;
  /** Public URL at which `remoteEntry.js` is served at runtime. */
  remoteEntryUrl: string;
  /**
   * Map of exposed path keys to their emitted chunk filenames.
   * @example { './Component': 'component-HASH.js' }
   */
  exposes: Record<ExposedPath | string, string>;
  /**
   * Map of shared package names to their version and optional chunk info.
   * When `chunkFilename` is absent the dependency is externalised (not bundled).
   */
  shared: Record<
    string,
    {
      version: SemverString | string;
      /** Emitted chunk filename when the dependency is bundled (not externalised). */
      chunkFilename?: string;
    }
  >;
  /** Unix timestamp (ms) of when this build manifest was generated. */
  buildTimestamp: number;
}

// ---------------------------------------------------------------------------
// Global augmentation
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __MF_CONTAINERS__: Record<string, RemoteContainer> | undefined;
  // eslint-disable-next-line no-var
  var __MF_MANIFEST__: RemoteManifest | undefined;
  // eslint-disable-next-line no-var
  var __MF_SHARED__: Record<
    string,
    {
      version: SemverString | string;
      singleton: boolean;
      /** Winning factory after version negotiation — returns the shared module instance. */
      factory: () => Promise<unknown>;
    }
  > | undefined;
}

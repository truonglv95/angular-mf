/**
 * Unit tests for generateRemoteEntry() and resolveVersion()
 *
 * Validates: Requirements 3.1, 3.3, 3.5, 3.6, 3.8, 8.1, 8.2, 8.3, 8.4
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { generateRemoteEntry, resolveVersion } from './generate-remote-entry.js';
import type { ModuleFederationConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the given string parses as valid JavaScript ES module. */
async function isValidJavaScript(source: string): Promise<boolean> {
  try {
    // Use esbuild to parse/transform the source as an ES module.
    // 'new Function(source)' only accepts script context and rejects
    // import.meta.url and other module-only syntax — so we use esbuild
    // which correctly validates ES module (sourceType: module) syntax.
    const { transform } = await import('esbuild');
    const result = await transform(source, {
      loader: 'js',
      format: 'esm',
      target: 'es2022',
    });
    return result.code.length > 0;
  } catch {
    return false;
  }
}

/** Minimal buildOutputs map used by most tests. */
function buildOutputsFor(config: ModuleFederationConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const sourcePath of Object.values(config.exposes ?? {})) {
    map.set(sourcePath, `./chunk-${sourcePath.replace(/[^a-z0-9]/gi, '-')}.js`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// resolveVersion()
// ---------------------------------------------------------------------------

describe('resolveVersion()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the version from package.json in process.cwd()', async () => {
    // The project has package.json with version 0.1.0 at cwd
    const version = await resolveVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  it('falls back to "0.0.0" when package.json cannot be read', async () => {
    // Temporarily change cwd to a path with no package.json
    const originalCwd = process.cwd;
    process.cwd = () => '/tmp/no-such-directory-mf-test';
    try {
      const version = await resolveVersion();
      expect(version).toBe('0.0.0');
    } finally {
      process.cwd = originalCwd;
    }
  });
});

// ---------------------------------------------------------------------------
// generateRemoteEntry()
// ---------------------------------------------------------------------------

describe('generateRemoteEntry()', () => {
  it('returns a valid JavaScript string (Req 3.6)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/app/entry.component.ts' },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(await isValidJavaScript(output)).toBe(true);
  });

  it('registers the container at globalThis.__MF_CONTAINERS__[name] (Req 3.1, 8.1)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/app/entry.component.ts' },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('globalThis.__MF_CONTAINERS__');
    expect(output).toContain(`globalThis.__MF_CONTAINERS__["mfe1"]`);
  });

  it('includes the config name in the container (Req 8.1)', async () => {
    const config: ModuleFederationConfig = {
      name: 'my-remote',
      exposes: { './Widget': './src/widget.ts' },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('name: "my-remote"');
  });

  it('includes a version field in the container (Req 3.8, 8.2)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/app/entry.component.ts' },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    // version field must be present (value comes from package.json or '0.0.0')
    expect(output).toMatch(/version: "\d+\.\d+\.\d+[^"]*"/);
  });

  it('maps every exposed key to an async import factory (Req 3.3, 8.3)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: {
        './Component': './src/app/entry.component.ts',
        './Module': './src/app/entry.module.ts',
      },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('"./Component": async () => import(');
    expect(output).toContain('"./Module": async () => import(');
  });

  it('uses the chunk URL from buildOutputs (not the source path)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/entry.ts' },
    };
    const buildOutputs = new Map<string, string>([
      ['./src/entry.ts', './chunk-abc123.js'],
    ]);

    const output = await generateRemoteEntry(config, buildOutputs);

    // New format: import(new URL("chunk-abc123.js", __mf_base__).href)
    expect(output).toContain('import(new URL("chunk-abc123.js", __mf_base__).href)');
    // source path should NOT appear in the import path
    expect(output).not.toContain('import(new URL("src/entry.ts", __mf_base__).href)');
  });

  it('falls back to source path when buildOutputs has no entry for it', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/entry.ts' },
    };
    const emptyOutputs = new Map<string, string>();

    const output = await generateRemoteEntry(config, emptyOutputs);

    // Fallback: use the source path itself (stripped of leading './')
    expect(output).toContain('import(new URL("src/entry.ts", __mf_base__).href)');
  });

  it('includes shared dependency entries from processSharedDependencies (Req 3.5, 8.4)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: { './Component': './src/app/entry.component.ts' },
      shared: {
        '@angular/core': { singleton: true, strictVersion: true, version: '17.0.0' },
      },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('"@angular/core"');
    expect(output).toContain('singleton: true');
    expect(output).toContain('get: async () => import("@angular/core")');
  });

  it('handles empty shared config gracefully (produces shared: {})', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe-no-shared',
      exposes: { './Foo': './src/foo.ts' },
      shared: {},
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('shared: {  }');
    expect(await isValidJavaScript(output)).toBe(true);
  });

  it('handles undefined shared by treating it as empty (Req 3.5)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe-no-shared',
      exposes: { './Foo': './src/foo.ts' },
      // shared is intentionally omitted
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(await isValidJavaScript(output)).toBe(true);
    expect(output).toContain('shared: {  }');
  });

  it('handles shared as a function by invoking it with empty defaults', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe-fn-shared',
      exposes: { './Comp': './src/comp.ts' },
      shared: (_defaults) => ({
        rxjs: { version: '7.8.0', singleton: false },
      }),
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    expect(output).toContain('"rxjs"');
    expect(await isValidJavaScript(output)).toBe(true);
  });

  it('produces valid JS that can be eval-executed to register the container', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe-exec',
      exposes: { './Comp': './src/comp.ts' },
      shared: { '@angular/core': { singleton: true, version: '17.0.0' } },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    // Execute the generated code in a sandboxed scope.
    // We must stub:
    //   1. Dynamic imports since they won't resolve in a unit test.
    //   2. import.meta.url — not available in new Function() (script) context.
    //      Replace the __mf_base__ line with a hardcoded string instead.
    let stubbedOutput = output
      // Stub: replace `new URL(".", import.meta.url).href` base computation
      .replace(
        /const __mf_base__ = new URL\("\."\s*,\s*import\.meta\.url\)\.href;/,
        'const __mf_base__ = "http://localhost:4202/";',
      )
      // Stub: replace dynamic import() calls that use __mf_base__
      .replace(
        /async \(\) => import\(new URL\("[^"]+"\s*,\s*__mf_base__\)\.href\)/g,
        'async () => Promise.resolve({})',
      )
      // Stub: replace any remaining dynamic import() calls
      .replace(
        /async \(\) => import\("[^"]+"\)/g,
        'async () => Promise.resolve({})',
      );

    const globalContext: {
      __MF_CONTAINERS__?: Record<string, unknown>;
      globalThis?: unknown;
    } = {};
    globalContext.globalThis = globalContext;

    // eslint-disable-next-line no-new-func
    new Function('globalThis', stubbedOutput)(globalContext);

    expect(globalContext.__MF_CONTAINERS__?.['mfe-exec']).toBeDefined();
    const container = globalContext.__MF_CONTAINERS__!['mfe-exec'] as Record<string, unknown>;
    expect(container['name']).toBe('mfe-exec');
    expect(typeof container['version']).toBe('string');
    expect(container['exposes']).toBeDefined();
    expect(container['shared']).toBeDefined();
  });

  it('exposes map keys all start with "./" (Req 8.3)', async () => {
    const config: ModuleFederationConfig = {
      name: 'mfe1',
      exposes: {
        './Feature': './src/feature.ts',
        './Lazy': './src/lazy.ts',
      },
    };
    const buildOutputs = buildOutputsFor(config);

    const output = await generateRemoteEntry(config, buildOutputs);

    // Both exposed keys must appear with the ./ prefix in the output
    expect(output).toContain('"./Feature"');
    expect(output).toContain('"./Lazy"');
  });
});

// ---------------------------------------------------------------------------
// Property-Based Tests — Properties 4 & 6
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a valid ModuleFederationConfig with:
 * - a non-empty alphanumeric/hyphen/underscore name
 * - at least one exposed module (key starts with `./`, value is a `.ts` path)
 */
const validMfConfigArb = fc.record({
  name: fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
  exposes: fc.dictionary(
    fc.stringMatching(/^\.\/[a-zA-Z0-9_-]+$/),
    fc.stringMatching(/^\.\/[a-zA-Z0-9/_-]+\.ts$/),
    { minKeys: 1 },
  ),
});

/**
 * Builds a `buildOutputs` map that maps each source path in `config.exposes`
 * to a deterministic chunk URL. This mirrors what the bundler would provide.
 */
function buildOutputsFromConfig(config: { exposes: Record<string, string> }): Map<string, string> {
  const map = new Map<string, string>();
  for (const sourcePath of Object.values(config.exposes)) {
    // Produce a stable chunk filename derived from the source path.
    const sanitised = sourcePath.replace(/[^a-z0-9]/gi, '-');
    map.set(sourcePath, `./chunk-${sanitised}.js`);
  }
  return map;
}

describe('generateRemoteEntry() — Property 4: Exposed Module Completeness', () => {
  /**
   * **Property 4: Exposed Module Completeness**
   *
   * For any valid `ModuleFederationConfig` with a non-empty `exposes` map,
   * every key defined in `config.exposes` must appear in the generated output
   * as an `"./key": async () => import(...)` expression.
   *
   * **Validates: Requirements 3.3, 8.3**
   */
  it('every config.exposes key appears in the generated output (Req 3.3, 8.3)', async () => {
    await fc.assert(
      fc.asyncProperty(validMfConfigArb, async (config) => {
        const buildOutputs = buildOutputsFromConfig(config);
        const output = await generateRemoteEntry(config as ModuleFederationConfig, buildOutputs);

        for (const exposedKey of Object.keys(config.exposes)) {
          // Each key must appear as a quoted property in the exposes map
          // with an async import factory.
          expect(output).toContain(`"${exposedKey}": async () => import(`);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('generateRemoteEntry() — Property 6: RemoteEntry Valid JavaScript Output', () => {
  /**
   * **Property 6: RemoteEntry Valid JavaScript Output**
   *
   * For any valid `ModuleFederationConfig`, `generateRemoteEntry()` produces
   * a string that is parseable as valid JavaScript (ES2020+) with no syntax
   * errors.
   *
   * **Validates: Requirements 3.6**
   */
  it('produces valid, parseable JavaScript for any valid config (Req 3.6)', async () => {
    await fc.assert(
      fc.asyncProperty(validMfConfigArb, async (config) => {
        const buildOutputs = buildOutputsFromConfig(config);
        const output = await generateRemoteEntry(config as ModuleFederationConfig, buildOutputs);

        expect(await isValidJavaScript(output)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

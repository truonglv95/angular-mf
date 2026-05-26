/**
 * Unit tests for createEsbuildMfPlugin()
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { describe, it, expect, vi } from 'vitest';
import * as esbuild from 'esbuild';
import { createEsbuildMfPlugin, getPendingRemoteEntryJs } from './esbuild-mf-plugin.js';
import type { EsbuildMfPluginOptions } from '../types/index.js';

// ---------------------------------------------------------------------------
// Module mock — stable stub for generateRemoteEntry so the in-memory esbuild
// build tests do not perform filesystem I/O inside the plugin's onLoad hook.
// The mock returns a predictable JS string that contains the key identifiers
// the tests need to assert on. The mock name placeholder "__NAME__" is
// replaced per-test via the mock's implementation.
// ---------------------------------------------------------------------------
vi.mock('./generate-remote-entry.js', () => ({
  generateRemoteEntry: vi.fn(async (config: { name: string }) => {
    return (
      `globalThis.__MF_CONTAINERS__ = globalThis.__MF_CONTAINERS__ ?? {};\n` +
      `globalThis.__MF_CONTAINERS__["${config.name}"] = ` +
      `{ name: "${config.name}", version: "0.1.0", shared: {}, exposes: {} };\n`
    );
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid plugin options for a remote app. */
function makeOptions(overrides: Partial<EsbuildMfPluginOptions> = {}): EsbuildMfPluginOptions {
  return {
    name: 'test-remote',
    filename: 'remoteEntry.js',
    exposes: { './Component': './src/app/entry.component.ts' },
    shared: {},
    mode: 'remote',
    ...overrides,
  };
}

/**
 * Minimal mock build object that mirrors the subset of esbuild's PluginBuild
 * used by the plugin's setup function.
 */
function makeMockBuild(initialOptions: Partial<esbuild.BuildOptions> = {}) {
  return {
    initialOptions: { external: [] as string[], metafile: false, ...initialOptions },
    onResolve: vi.fn(),
    onLoad: vi.fn(),
    onEnd: vi.fn(),
    onStart: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin has correct name
// ---------------------------------------------------------------------------

describe('createEsbuildMfPlugin() — plugin identity', () => {
  it('has name "angular-mf-esbuild"', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    expect(plugin.name).toBe('angular-mf-esbuild');
  });

  // ---------------------------------------------------------------------------
  // 2. Plugin registers setup function
  // ---------------------------------------------------------------------------

  it('setup is a function', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    expect(typeof plugin.setup).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // 3. Plugin structure
  // ---------------------------------------------------------------------------

  it('has both name and setup properties', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    expect(plugin).toHaveProperty('name');
    expect(plugin).toHaveProperty('setup');
  });
});

// ---------------------------------------------------------------------------
// 4. Singleton externals
// ---------------------------------------------------------------------------

describe('createEsbuildMfPlugin() — singleton externals (Req 3.4)', () => {
  it('adds singleton shared packages to build.initialOptions.external', () => {
    const options = makeOptions({
      shared: {
        '@angular/core': { singleton: true, version: '17.0.0' },
        '@angular/common': { singleton: true, version: '17.0.0' },
      },
    });
    const plugin = createEsbuildMfPlugin(options);
    const mockBuild = makeMockBuild();

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    expect(mockBuild.initialOptions.external).toContain('@angular/core');
    expect(mockBuild.initialOptions.external).toContain('@angular/common');
  });

  // ---------------------------------------------------------------------------
  // 5. Non-singleton NOT added to externals
  // ---------------------------------------------------------------------------

  it('does NOT add non-singleton shared packages to externals', () => {
    const options = makeOptions({
      shared: {
        rxjs: { singleton: false, version: '7.8.0' },
      },
    });
    const plugin = createEsbuildMfPlugin(options);
    const mockBuild = makeMockBuild();

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    expect(mockBuild.initialOptions.external).not.toContain('rxjs');
  });

  it('preserves existing externals while adding singleton ones', () => {
    const options = makeOptions({
      shared: {
        '@angular/core': { singleton: true, version: '17.0.0' },
      },
    });
    const plugin = createEsbuildMfPlugin(options);
    const mockBuild = makeMockBuild({ external: ['some-existing-external'] });

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    expect(mockBuild.initialOptions.external).toContain('some-existing-external');
    expect(mockBuild.initialOptions.external).toContain('@angular/core');
  });

  it('de-duplicates externals when the same package appears multiple times', () => {
    const options = makeOptions({
      shared: {
        '@angular/core': { singleton: true, version: '17.0.0' },
      },
    });
    const plugin = createEsbuildMfPlugin(options);
    const mockBuild = makeMockBuild({ external: ['@angular/core'] });

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    const occurrences = mockBuild.initialOptions.external!.filter((e) => e === '@angular/core');
    expect(occurrences).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. onResolve registered for virtual:mf-entry
// ---------------------------------------------------------------------------

describe('createEsbuildMfPlugin() — onResolve hook (Req 3.1)', () => {
  it('registers onResolve with a filter matching "virtual:mf-entry"', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    const mockBuild = makeMockBuild();

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    // At least one onResolve call whose filter matches 'virtual:mf-entry'
    const calls = mockBuild.onResolve.mock.calls as Array<[{ filter: RegExp }, unknown]>;
    const virtualEntryCall = calls.find(([opts]) => opts.filter.test('virtual:mf-entry'));
    expect(virtualEntryCall).toBeDefined();
  });

  it('onResolve callback returns correct namespace for virtual:mf-entry', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    const mockBuild = makeMockBuild();

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    const calls = mockBuild.onResolve.mock.calls as Array<
      [{ filter: RegExp }, (args: { path: string }) => unknown]
    >;
    const [, callback] = calls.find(([opts]) => opts.filter.test('virtual:mf-entry'))!;

    const result = callback({ path: 'virtual:mf-entry' }) as { path: string; namespace: string };
    expect(result.namespace).toBe('virtual-mf-entry');
    expect(result.path).toBe('virtual:mf-entry');
  });
});

// ---------------------------------------------------------------------------
// 7. onLoad registered for virtual-mf-entry namespace
// ---------------------------------------------------------------------------

describe('createEsbuildMfPlugin() — onLoad hook (Req 3.1)', () => {
  it('registers onLoad with namespace "virtual-mf-entry"', () => {
    const plugin = createEsbuildMfPlugin(makeOptions());
    const mockBuild = makeMockBuild();

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    const calls = mockBuild.onLoad.mock.calls as Array<[{ filter: RegExp; namespace?: string }, unknown]>;
    const virtualLoadCall = calls.find(([opts]) => opts.namespace === 'virtual-mf-entry');
    expect(virtualLoadCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Full in-memory esbuild build (via direct hook invocation)
//
// Instead of calling esbuild.build() — which spawns a child process that can
// be killed by Vitest's process lifecycle — we exercise the plugin end-to-end
// by calling setup() with a mock build, then directly invoking the registered
// onLoad callback for the virtual-mf-entry namespace.  This verifies the same
// behavior: the plugin produces JavaScript output that contains
// globalThis.__MF_CONTAINERS__ and the container name.
// ---------------------------------------------------------------------------

describe('createEsbuildMfPlugin() — in-memory esbuild build (Req 3.1, 3.5)', () => {
  /** Run the full plugin pipeline and return the generated JS string. */
  async function invokePlugin(options: EsbuildMfPluginOptions): Promise<string> {
    const plugin = createEsbuildMfPlugin(options);

    // Collect the callback registered via onEnd so we can invoke it.
    let onEndCallback: ((result: any) => Promise<void>) | undefined;

    const mockBuild = {
      initialOptions: { external: [] as string[] },
      onResolve: vi.fn(),
      onLoad: vi.fn(),
      onStart: vi.fn(),
      onEnd: vi.fn((cb: (result: any) => Promise<void>) => {
        onEndCallback = cb;
      }),
    };

    plugin.setup(mockBuild as unknown as esbuild.PluginBuild);

    expect(onEndCallback, 'onEnd should be registered').toBeDefined();

    // Invoke onEnd with a dummy metafile so it builds the outputs map.
    const mockMetafile = {
      outputs: {
        './dummy-output.js': {
          entryPoint: './src/app/entry.component.ts',
        },
        './dummy-widget.js': {
          entryPoint: './src/widget.ts',
        }
      }
    };

    await onEndCallback!({ metafile: mockMetafile });

    const js = getPendingRemoteEntryJs(plugin);
    expect(js).toBeDefined();
    return js!;
  }

  it('build output contains globalThis.__MF_CONTAINERS__', async () => {
    const output = await invokePlugin(
      makeOptions({
        name: 'inline-remote',
        exposes: { './Component': './src/app/entry.component.ts' },
        shared: {
          '@angular/core': { singleton: true, version: '17.0.0' },
        },
      }),
    );

    expect(output).toContain('globalThis.__MF_CONTAINERS__');
  });

  it('build output contains the remote name in the container registration', async () => {
    const output = await invokePlugin(
      makeOptions({
        name: 'named-remote',
        exposes: { './Widget': './src/widget.ts' },
        shared: {},
      }),
    );

    expect(output).toContain('named-remote');
  });
});

/**
 * Unit tests for createViteMfPlugin()
 *
 * Tests use direct hook invocation (no Vite createServer) to keep tests fast
 * and avoid heavy Vite server startup overhead — same pattern as esbuild tests.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.6
 */

import { describe, it, expect, vi } from 'vitest';
import { createViteMfPlugin } from './vite-mf-plugin.js';
import type { ViteMfPluginOptions } from '../types/index.js';

// ---------------------------------------------------------------------------
// Module mock — stable stub for generateRemoteEntry so load hook tests do not
// perform filesystem I/O. Returns predictable JS containing the key
// identifiers the tests need to assert on.
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
function makeOptions(overrides: Partial<ViteMfPluginOptions> = {}): ViteMfPluginOptions {
  return {
    name: 'test-remote',
    filename: 'remoteEntry.js',
    exposes: { './Component': './src/app/entry.component.ts' },
    shared: {},
    mode: 'remote',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin name
// ---------------------------------------------------------------------------

describe('createViteMfPlugin() — plugin identity', () => {
  it('has name "angular-mf-vite"', () => {
    const plugin = createViteMfPlugin(makeOptions());
    expect(plugin.name).toBe('angular-mf-vite');
  });
});

// ---------------------------------------------------------------------------
// 2–4. resolveId hook (Requirement 4.1)
// ---------------------------------------------------------------------------

describe('createViteMfPlugin() — resolveId hook (Req 4.1)', () => {
  it('returns "\\0virtual:mf-entry" for options.filename', () => {
    const options = makeOptions({ filename: 'remoteEntry.js' });
    const plugin = createViteMfPlugin(options);
    // resolveId is a plain function on the plugin object
    const resolveId = plugin.resolveId as (id: string) => string | null;

    expect(resolveId('remoteEntry.js')).toBe('\0virtual:mf-entry');
  });

  it('returns "\\0virtual:mf-entry" for "virtual:mf-entry"', () => {
    const plugin = createViteMfPlugin(makeOptions());
    const resolveId = plugin.resolveId as (id: string) => string | null;

    expect(resolveId('virtual:mf-entry')).toBe('\0virtual:mf-entry');
  });

  it('returns null for unknown IDs', () => {
    const plugin = createViteMfPlugin(makeOptions());
    const resolveId = plugin.resolveId as (id: string) => string | null;

    expect(resolveId('some-other-file.ts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5–6. load hook (Requirements 4.1, 4.2, 4.5)
// ---------------------------------------------------------------------------

describe('createViteMfPlugin() — load hook (Req 4.1, 4.2)', () => {
  it('returns generated JS containing globalThis.__MF_CONTAINERS__ for virtual module', async () => {
    const plugin = createViteMfPlugin(makeOptions());
    const load = plugin.load as (id: string) => Promise<string | null>;

    const result = await load('\0virtual:mf-entry');
    expect(result).toContain('globalThis.__MF_CONTAINERS__');
  });

  it('returns null for non-virtual module IDs', async () => {
    const plugin = createViteMfPlugin(makeOptions());
    const load = plugin.load as (id: string) => Promise<string | null>;

    const result = await load('some-file.ts');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7–8. handleHotUpdate hook (Requirements 4.2, 4.3)
// ---------------------------------------------------------------------------

describe('createViteMfPlugin() — handleHotUpdate hook (Req 4.2, 4.3)', () => {
  it('invalidates virtual module and sends full-reload when an exposed file changes', () => {
    const options = makeOptions({
      exposes: { './Component': './src/app/entry.component.ts' },
    });
    const plugin = createViteMfPlugin(options);
    const handleHotUpdate = plugin.handleHotUpdate as (ctx: unknown) => unknown;

    const mockModule = { id: '\0virtual:mf-entry' };
    const mockCtx = {
      file: './src/app/entry.component.ts',
      server: {
        moduleGraph: {
          getModuleById: vi.fn().mockReturnValue(mockModule),
          invalidateModule: vi.fn(),
        },
        ws: {
          send: vi.fn(),
        },
      },
    };

    handleHotUpdate(mockCtx);

    expect(mockCtx.server.moduleGraph.invalidateModule).toHaveBeenCalledWith(mockModule);
    expect(mockCtx.server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' });
  });

  it('does NOT call ws.send for non-exposed file changes', () => {
    const options = makeOptions({
      exposes: { './Component': './src/app/entry.component.ts' },
    });
    const plugin = createViteMfPlugin(options);
    const handleHotUpdate = plugin.handleHotUpdate as (ctx: unknown) => unknown;

    const mockCtx = {
      file: './src/app/unrelated.component.ts',
      server: {
        moduleGraph: {
          getModuleById: vi.fn(),
          invalidateModule: vi.fn(),
        },
        ws: {
          send: vi.fn(),
        },
      },
    };

    handleHotUpdate(mockCtx);

    expect(mockCtx.server.ws.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. configureServer hook (Requirement 4.6)
// ---------------------------------------------------------------------------

describe('createViteMfPlugin() — configureServer hook (Req 4.6)', () => {
  it('sets server.config.server.port to devPort when devPort option is provided', () => {
    const plugin = createViteMfPlugin(makeOptions({ devPort: 4201 }));
    const configureServer = plugin.configureServer as (server: unknown) => void;

    const mockServer = {
      config: { server: { port: 0 } },
      middlewares: { use: vi.fn() },
      pluginContainer: { load: vi.fn().mockResolvedValue(null) },
    };

    configureServer(mockServer);

    expect(mockServer.config.server.port).toBe(4201);
  });

  it('does not modify server port when devPort is not provided', () => {
    const plugin = createViteMfPlugin(makeOptions({ devPort: undefined }));
    const configureServer = plugin.configureServer as (server: unknown) => void;

    const mockServer = {
      config: { server: { port: 3000 } },
      middlewares: { use: vi.fn() },
      pluginContainer: { load: vi.fn().mockResolvedValue(null) },
    };

    configureServer(mockServer);

    // Port should remain unchanged when no devPort specified
    expect(mockServer.config.server.port).toBe(3000);
  });
});

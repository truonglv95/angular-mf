/**
 * Tests for initFederation()
 *
 * Covers:
 *  - Unit tests for all behaviour branches
 *  - Property 10: Manifest Round-Trip Registration
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initFederation } from './init-federation.js';
import type { RemoteManifest } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Response object. */
function makeMockResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  jsonThrows?: boolean;
}): Response {
  const {
    ok,
    status = ok ? 200 : 500,
    statusText = ok ? 'OK' : 'Internal Server Error',
    body,
    jsonThrows,
  } = opts;

  return {
    ok,
    status,
    statusText,
    json: jsonThrows
      ? () => Promise.reject(new SyntaxError('Unexpected token'))
      : () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset the global manifest between tests.
  globalThis.__MF_MANIFEST__ = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Branch A: manifest is already an object
// ---------------------------------------------------------------------------

describe('initFederation() — object manifest', () => {
  it('registers the manifest directly without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const manifest: RemoteManifest = {
      mfe1: { remoteEntry: 'http://localhost:4201/remoteEntry.js' },
      mfe2: { remoteEntry: 'http://localhost:4202/remoteEntry.js' },
    };

    await initFederation(manifest);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalThis.__MF_MANIFEST__).toBe(manifest);
  });

  it('populates __MF_MANIFEST__ with the provided object', async () => {
    const manifest: RemoteManifest = {
      shell: { remoteEntry: 'https://cdn.example.com/shell/remoteEntry.js' },
    };

    await initFederation(manifest);

    expect(globalThis.__MF_MANIFEST__?.['shell']?.remoteEntry).toBe(
      'https://cdn.example.com/shell/remoteEntry.js',
    );
  });
});

// ---------------------------------------------------------------------------
// Branch B: manifest is a URL string
// ---------------------------------------------------------------------------

describe('initFederation() — URL string manifest', () => {
  it('fetches, parses, and registers a valid manifest', async () => {
    const manifest: RemoteManifest = {
      mfe1: { remoteEntry: 'http://localhost:4201/remoteEntry.js' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({ ok: true, body: manifest }),
    );

    await initFederation('/assets/manifest.json');

    expect(globalThis.__MF_MANIFEST__).toEqual(manifest);
  });

  it('calls fetch with the provided URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeMockResponse({ ok: true, body: {} }));

    await initFederation('https://example.com/manifest.json');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/manifest.json');
  });
});

// ---------------------------------------------------------------------------
// Error: unreachable URL (fetch throws)
// ---------------------------------------------------------------------------

describe('initFederation() — unreachable URL', () => {
  it('rejects with a descriptive error when fetch throws a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to fetch'),
    );

    await expect(
      initFederation('http://unreachable.example.com/manifest.json'),
    ).rejects.toThrow(
      '[MF] initFederation: Failed to fetch manifest from "http://unreachable.example.com/manifest.json": Failed to fetch',
    );
  });

  it('includes the URL in the error message', async () => {
    const url = 'http://offline.example.com/manifest.json';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(initFederation(url)).rejects.toThrow(url);
  });
});

// ---------------------------------------------------------------------------
// Error: HTTP error (response.ok === false)
// ---------------------------------------------------------------------------

describe('initFederation() — HTTP error response', () => {
  it('rejects with HTTP status and statusText when response.ok is false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );

    await expect(
      initFederation('http://example.com/missing.json'),
    ).rejects.toThrow(
      '[MF] initFederation: Failed to fetch manifest from "http://example.com/missing.json": HTTP 404 Not Found',
    );
  });

  it('rejects with HTTP 503 when server is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }),
    );

    await expect(
      initFederation('http://example.com/manifest.json'),
    ).rejects.toThrow('HTTP 503 Service Unavailable');
  });
});

// ---------------------------------------------------------------------------
// Error: non-JSON response body
// ---------------------------------------------------------------------------

describe('initFederation() — non-JSON response', () => {
  it('rejects with a descriptive error when response.json() throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({ ok: true, jsonThrows: true }),
    );

    await expect(
      initFederation('http://example.com/manifest.json'),
    ).rejects.toThrow(
      '[MF] initFederation: Manifest at "http://example.com/manifest.json" is not valid JSON',
    );
  });

  it('rejects when parsed JSON is an array instead of object', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({ ok: true, body: [] }),
    );

    await expect(
      initFederation('http://example.com/manifest.json'),
    ).rejects.toThrow(
      '[MF] initFederation: Manifest at "http://example.com/manifest.json" is not valid JSON: expected an object, got array',
    );
  });

  it('rejects when parsed JSON is a primitive (string)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse({ ok: true, body: 'not-an-object' }),
    );

    await expect(
      initFederation('http://example.com/manifest.json'),
    ).rejects.toThrow('is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Property 10: Manifest Round-Trip Registration
// Validates: Requirements 5.2, 5.3, 5.5
// ---------------------------------------------------------------------------

describe('Property 10: Manifest Round-Trip Registration', () => {
  it(
    'for any RemoteManifest object, all remote entries are preserved exactly in __MF_MANIFEST__',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
            fc.record({
              remoteEntry: fc.webUrl(),
              integrity: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            }),
            { minKeys: 1, maxKeys: 10 },
          ),
          async (manifest) => {
            // Reset global state for each generated example.
            globalThis.__MF_MANIFEST__ = undefined;

            // Cast: filter out undefined integrity fields to match RemoteManifest type.
            const typedManifest = Object.fromEntries(
              Object.entries(manifest).map(([name, entry]) => {
                const v: { remoteEntry: string; integrity?: string } = {
                  remoteEntry: entry.remoteEntry,
                };
                if (entry.integrity != null) v.integrity = entry.integrity;
                return [name, v];
              }),
            ) as RemoteManifest;

            await initFederation(typedManifest);

            // Every remote name must map to the exact same remoteEntry URL.
            for (const [name, { remoteEntry }] of Object.entries(typedManifest)) {
              if (globalThis.__MF_MANIFEST__?.[name]?.remoteEntry !== remoteEntry) {
                return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

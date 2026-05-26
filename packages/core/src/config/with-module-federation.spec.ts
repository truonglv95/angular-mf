/**
 * Tests for `withModuleFederation()` — MF Config helper
 *
 * Unit tests covering validation, defaults, and shared config resolution.
 * Property test (Property 7) covering Config Name Validation.
 *
 * **Validates: Requirements 2.5, 2.6, 2.7, 2.8**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { withModuleFederation } from '../config/with-module-federation.js';

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('withModuleFederation()', () => {
  // ── Name validation ────────────────────────────────────────────────────────

  describe('name validation', () => {
    it('rejects an empty string name', () => {
      expect(() => withModuleFederation({ name: '' })).toThrow();
    });

    it('rejects a name with a space', () => {
      expect(() => withModuleFederation({ name: 'my app' })).toThrow();
    });

    it('rejects a name with a leading space', () => {
      expect(() => withModuleFederation({ name: ' myapp' })).toThrow();
    });

    it('rejects a name with a trailing space', () => {
      expect(() => withModuleFederation({ name: 'myapp ' })).toThrow();
    });

    it('rejects a name containing a tab character', () => {
      expect(() => withModuleFederation({ name: 'my\tapp' })).toThrow();
    });

    it('rejects a name containing a newline character', () => {
      expect(() => withModuleFederation({ name: 'my\napp' })).toThrow();
    });

    it('accepts a plain alphanumeric name', () => {
      expect(() => withModuleFederation({ name: 'myapp' })).not.toThrow();
    });

    it('accepts a name with hyphens and underscores', () => {
      expect(() => withModuleFederation({ name: 'my-app_v2' })).not.toThrow();
    });
  });

  // ── Exposes key validation ─────────────────────────────────────────────────

  describe('exposes key validation', () => {
    it('rejects exposes keys that do not start with "./"', () => {
      expect(() =>
        withModuleFederation({
          name: 'mfe1',
          exposes: { Component: './src/app/app.component.ts' },
        }),
      ).toThrow();
    });

    it('rejects a mix of valid and invalid exposes keys', () => {
      expect(() =>
        withModuleFederation({
          name: 'mfe1',
          exposes: {
            './Component': './src/app/app.component.ts',
            'BadKey': './src/app/bad.ts',
          },
        }),
      ).toThrow();
    });

    it('accepts exposes keys that all start with "./"', () => {
      expect(() =>
        withModuleFederation({
          name: 'mfe1',
          exposes: {
            './Component': './src/app/app.component.ts',
            './Module': './src/app/app.module.ts',
          },
        }),
      ).not.toThrow();
    });
  });

  // ── Default filename ───────────────────────────────────────────────────────

  describe('default filename', () => {
    it("defaults filename to 'remoteEntry.js' when omitted", () => {
      const result = withModuleFederation({ name: 'mfe1' });
      expect(result.filename).toBe('remoteEntry.js');
    });

    it('preserves a custom filename when provided', () => {
      const result = withModuleFederation({ name: 'mfe1', filename: 'custom.js' });
      expect(result.filename).toBe('custom.js');
    });
  });

  // ── Angular peer dep defaults (Requirement 2.7) ───────────────────────────

  describe('Angular peer dep defaults', () => {
    it('auto-merges @angular/core as a singleton shared dep', () => {
      const result = withModuleFederation({ name: 'mfe1' });
      expect(result.shared).toMatchObject({
        '@angular/core': { singleton: true, strictVersion: true },
      });
    });

    it('auto-merges @angular/common as a singleton shared dep', () => {
      const result = withModuleFederation({ name: 'mfe1' });
      expect(result.shared).toMatchObject({
        '@angular/common': { singleton: true, strictVersion: true },
      });
    });

    it('auto-merges @angular/router as a singleton shared dep', () => {
      const result = withModuleFederation({ name: 'mfe1' });
      expect(result.shared).toMatchObject({
        '@angular/router': { singleton: true, strictVersion: true },
      });
    });

    it('merges explicit shared config on top of Angular defaults', () => {
      const result = withModuleFederation({
        name: 'mfe1',
        shared: {
          'rxjs': { singleton: true },
        },
      });
      // Angular defaults still present
      expect(result.shared).toMatchObject({
        '@angular/core': { singleton: true, strictVersion: true },
      });
      // Explicit entry also present
      expect(result.shared).toMatchObject({
        'rxjs': { singleton: true },
      });
    });

    it('allows explicit shared config to override Angular defaults for a matching package', () => {
      const result = withModuleFederation({
        name: 'mfe1',
        shared: {
          '@angular/core': { singleton: false },
        },
      });
      // Explicit override wins
      expect((result.shared as Record<string, unknown>)['@angular/core']).toEqual({
        singleton: false,
      });
    });
  });

  // ── Function-form shared (Requirement 2.8) ────────────────────────────────

  describe('function-form shared', () => {
    it('invokes the shared function with Angular defaults and uses its result', () => {
      const customShared = { 'my-lib': { singleton: true } };

      const sharedFn = (defaults: Record<string, unknown>) => {
        // Verify the function receives the Angular defaults
        expect(defaults).toMatchObject({
          '@angular/core': { singleton: true, strictVersion: true },
          '@angular/common': { singleton: true, strictVersion: true },
          '@angular/router': { singleton: true, strictVersion: true },
        });
        return customShared;
      };

      const result = withModuleFederation({ name: 'mfe1', shared: sharedFn });
      expect(result.shared).toBe(customShared);
    });

    it('uses the function return value as the entire shared config (not merged)', () => {
      // The function decides what to return — it could return just a subset
      const result = withModuleFederation({
        name: 'mfe1',
        shared: () => ({ 'only-this': { singleton: true } }),
      });
      expect(result.shared).toEqual({ 'only-this': { singleton: true } });
      // @angular/core NOT present because the function chose not to include it
      expect(result.shared).not.toHaveProperty('@angular/core');
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based test: Property 7 — Config Name Validation
// **Validates: Requirements 2.6, 8.5**
// ---------------------------------------------------------------------------

describe('Property 7: Config Name Validation', () => {
  it('throws for any name that is empty or contains whitespace', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => /\s/.test(s) || s.length === 0),
        (invalidName) => {
          expect(() => withModuleFederation({ name: invalidName })).toThrow();
        },
      ),
    );
  });

  it('accepts any name made of alphanumeric characters, hyphens, or underscores', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9\-_]+$/),
        (validName) => {
          expect(() => withModuleFederation({ name: validName })).not.toThrow();
        },
      ),
    );
  });
});

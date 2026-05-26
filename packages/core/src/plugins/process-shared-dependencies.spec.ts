/**
 * Unit tests for processSharedDependencies()
 *
 * Validates: Requirements 3.4, 3.5, 7.1, 7.2
 */

import { describe, it, expect } from 'vitest';
import { processSharedDependencies } from './process-shared-dependencies.js';
import type { SharedConfig } from '../types/index.js';

describe('processSharedDependencies()', () => {
  it('returns an empty array for an empty SharedConfig', () => {
    const result = processSharedDependencies({});
    expect(result).toEqual([]);
  });

  it('returns one fragment per shared package', () => {
    const shared: SharedConfig = {
      '@angular/core': { singleton: true, strictVersion: true, version: '17.0.0' },
      '@angular/common': { singleton: true, strictVersion: false, version: '17.0.0' },
    };
    const result = processSharedDependencies(shared);
    expect(result).toHaveLength(2);
  });

  it('includes the correct version in the fragment', () => {
    const shared: SharedConfig = {
      rxjs: { version: '7.8.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('version: "7.8.0"');
  });

  it('falls back to "*" when version is not provided and package is not installed (Req 3.5)', () => {
    const shared: SharedConfig = {
      // Use a package name that definitely does not exist in node_modules
      '__non-existent-test-package__': { singleton: true },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('version: "*"');
  });

  it('auto-resolves version from node_modules when version is not provided (Req 3.5)', () => {
    const shared: SharedConfig = {
      // semver is a real dependency we know is installed
      semver: { singleton: true },
    };
    const [fragment] = processSharedDependencies(shared);
    // Should contain a real semver version (e.g. "7.x.x"), not "*"
    expect(fragment).toMatch(/version: "\d+\.\d+\.\d+"/);
  });

  it('sets singleton: true when configured (Req 7.1)', () => {
    const shared: SharedConfig = {
      '@angular/core': { singleton: true, version: '17.0.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('singleton: true');
  });

  it('sets singleton: false when not configured', () => {
    const shared: SharedConfig = {
      lodash: { version: '4.17.21' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('singleton: false');
  });

  it('sets strictVersion: true when configured (Req 7.2)', () => {
    const shared: SharedConfig = {
      '@angular/router': { strictVersion: true, version: '17.0.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('strictVersion: true');
  });

  it('sets strictVersion: false when not configured', () => {
    const shared: SharedConfig = {
      '@angular/router': { version: '17.0.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('strictVersion: false');
  });

  it('includes an async get factory importing the package by name', () => {
    const shared: SharedConfig = {
      '@angular/core': { singleton: true, version: '17.0.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain(`get: async () => import("@angular/core")`);
  });

  it('uses the package name as the property key in the fragment', () => {
    const shared: SharedConfig = {
      '@angular/platform-browser': { singleton: true, version: '17.0.0' },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toMatch(/^"@angular\/platform-browser":/);
  });

  it('produces fragments that can be joined into a valid JS object literal', () => {
    const shared: SharedConfig = {
      '@angular/core': { singleton: true, strictVersion: true, version: '17.0.0' },
      '@angular/common': { singleton: true, strictVersion: false, version: '17.0.0' },
    };
    const fragments = processSharedDependencies(shared);
    const jsSource = `const shared = { ${fragments.join(', ')} };`;

    // Should parse without syntax errors
    expect(() => new Function(jsSource)).not.toThrow();
  });

  it('handles a package with all SharedLibraryConfig fields set', () => {
    const shared: SharedConfig = {
      'zone.js': {
        singleton: true,
        strictVersion: true,
        version: '0.14.2',
        requiredVersion: '^0.14.0',
        eager: true,
      },
    };
    const [fragment] = processSharedDependencies(shared);
    expect(fragment).toContain('version: "0.14.2"');
    expect(fragment).toContain('singleton: true');
    expect(fragment).toContain('strictVersion: true');
    expect(fragment).toContain('get: async () => import("zone.js")');
  });
});

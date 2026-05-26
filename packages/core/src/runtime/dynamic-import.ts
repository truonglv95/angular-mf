/**
 * Thin wrapper around native ESM dynamic `import()`.
 *
 * Isolating `import()` in a dedicated module makes it possible to mock
 * this function in unit/property-based tests without altering the
 * production security contract (Req 11.2: no `eval()` / `new Function()`).
 *
 * The runtime always uses native ESM `import()` through this wrapper.
 *
 * @param url - Absolute URL of the ESM script to load at runtime.
 * @returns A Promise that resolves to the loaded module namespace.
 */
export async function dynamicImport(url: string): Promise<unknown> {
  // The /* @vite-ignore */ comment suppresses Vite's dynamic-import
  // analysis warning for a runtime-provided URL.
  return import(/* @vite-ignore */ url);
}

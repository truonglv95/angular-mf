/**
 * createViteMfPlugin — Vite Plugin for Module Federation (development server).
 *
 * This plugin wires Module Federation into Angular's Vite dev server pipeline:
 *
 *  1. Intercepts requests for `remoteEntry.js` (and `virtual:mf-entry`) via
 *     `resolveId`, returning a virtual module that is served from memory.
 *  2. Serves the generated `remoteEntry.js` source via the `load` hook,
 *     delegating to `generateRemoteEntry()` with dev-mode source paths.
 *  3. Invalidates and re-serves the virtual remoteEntry when any exposed
 *     module source file changes, triggering an HMR full-reload within
 *     the target latency of < 200 ms (Requirement 4.4).
 *  4. Optionally configures the dev server port when `devPort` is provided
 *     (Requirement 4.6).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type { Plugin, ViteDevServer, HmrContext } from 'vite';
import { generateRemoteEntry } from './generate-remote-entry.js';
import type { ViteMfPluginOptions, ModuleFederationConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unprefixed virtual module ID — used in `resolveId` matching. */
const VIRTUAL_MF_ENTRY = 'virtual:mf-entry';

/**
 * Resolved (prefixed) virtual module ID that Vite uses internally.
 * The `\0` prefix is a Vite convention that prevents other plugins from
 * accidentally resolving or transforming the virtual module.
 */
const RESOLVED_VIRTUAL_MF_ENTRY = '\0virtual:mf-entry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the `buildOutputs` map that `generateRemoteEntry()` expects.
 *
 * In development mode, exposed modules are served directly by Vite from
 * their source paths — there is no compiled chunk. We therefore map each
 * source path to itself so that the generated `import()` factories reference
 * the live Vite-served source files (which Vite transforms on the fly).
 *
 * @param exposes - Map of exposed path keys → source file paths from options.
 * @returns Map of source path → virtual URL (source path itself in dev mode).
 */
import * as fs from 'fs';
function buildOutputsMap(exposes: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  let log = 'buildOutputsMap called\\n';
  for (const [key, sourcePath] of Object.entries(exposes)) {
    const entryName = key.startsWith('./') ? key.slice(2) : key;
    map.set(sourcePath, `./${entryName}.js`);
    log += `Mapping [${key}] sourcePath [${sourcePath}] to [./${entryName}.js]\\n`;
  }
  fs.appendFileSync('mf-debug.log', log);
  return map;
}

/**
 * Converts `ViteMfPluginOptions` into a `ModuleFederationConfig` compatible
 * with `generateRemoteEntry()`.
 *
 * @param options - Resolved Vite MF plugin options.
 * @returns Equivalent `ModuleFederationConfig` for the generator.
 */
function toMfConfig(options: ViteMfPluginOptions): ModuleFederationConfig {
  return {
    name: options.name,
    filename: options.filename,
    exposes: options.exposes,
    shared: options.shared,
  };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates a Vite `Plugin` that adds Module Federation dev-server support to
 * an Angular application.
 *
 * **Preconditions:**
 * - `options.name` is non-empty (validated upstream by `withModuleFederation()`).
 * - `options.filename` is the desired remote entry filename (e.g. `'remoteEntry.js'`).
 * - `options.exposes` is the map of exposed keys → source file paths.
 * - `options.shared` is a resolved `SharedConfig` object (not a function).
 *
 * **Postconditions:**
 * - The returned `Plugin` object has `name === 'angular-mf-vite'`.
 * - Requests for `options.filename` or `virtual:mf-entry` are served as a
 *   virtual module backed by `generateRemoteEntry()`.
 * - HMR file changes to any exposed source file trigger invalidation of the
 *   virtual module and a full-reload broadcast to all connected clients.
 *   End-to-end latency target: < 200 ms.
 *
 * @param options - Resolved Module Federation plugin options.
 * @returns A Vite `Plugin` ready to be passed to the `plugins` array of a
 *          Vite configuration.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
export function createViteMfPlugin(options: ViteMfPluginOptions): Plugin {
  return {
    name: 'angular-mf-vite',

    enforce: 'pre',

    resolveId(id: string): any {
      if (
        id === options.filename ||
        id === `/${options.filename}` ||
        id === VIRTUAL_MF_ENTRY
      ) {
        return RESOLVED_VIRTUAL_MF_ENTRY;
      }
      if (id.startsWith('/mf-shared/')) {
        return { id, external: true } as any;
      }
      
      const isShared = Object.entries(options.shared).some(([pkg, cfg]) => cfg.singleton && id === pkg);
      if (isShared) {
        console.log('[MF Vite Debug] Intercepted:', id);
        return '\\0mf-shared:' + id;
      }

      return null;
    },

    // -----------------------------------------------------------------------
    // 2. load hook (Requirement 4.1, 4.2, 4.5)
    //
    // Generates the `remoteEntry.js` source string on demand by calling
    // `generateRemoteEntry()` with a dev-mode `buildOutputs` map where every
    // source path maps to itself (Vite handles transformation at request time).
    //
    // Shared dependency negotiation (Requirement 4.5) is embedded in the
    // generated container's `shared` map via `processSharedDependencies()`,
    // which is called internally by `generateRemoteEntry()`.
    // -----------------------------------------------------------------------
    async load(id: string): Promise<string | null> {
      if (id.startsWith('\\0mf-shared:')) {
        const pkgName = id.replace('\\0mf-shared:', '');
        let keys: string[] = [];
        try {
          const pkg = await import(pkgName);
          keys = Object.keys(pkg).filter(k => k !== 'default');
        } catch (e) {
          console.warn(`[MF] Could not introspect ${pkgName}.`, e);
        }
        let contents = `const shared = await globalThis.__MF_SHARED__['${pkgName}'].get();\\n`;
        if (keys.length > 0) {
          contents += keys.map(k => `export const ${k} = shared.${k};`).join('\\n');
        }
        contents += `\\nexport default shared;`;
        return contents;
      }

      if (id !== RESOLVED_VIRTUAL_MF_ENTRY) {
        return null;
      }

      // Build the source-path → URL map used by generateRemoteEntry.
      // In dev mode URLs equal source paths — Vite serves them directly.
      const buildOutputs = buildOutputsMap(options.exposes);

      // Construct the ModuleFederationConfig for the generator.
      const config = toMfConfig(options);

      // Delegate to the shared generator (Algorithm 1 from the design doc).
      const js = await generateRemoteEntry(config, buildOutputs);
      return js;
    },

    // -----------------------------------------------------------------------
    // 3. handleHotUpdate hook (Requirement 4.2, 4.3, 4.4)
    //
    // When any source file that belongs to an exposed module changes, we:
    //   a) Invalidate the cached virtual remoteEntry module in Vite's
    //      module graph so the next request regenerates it.
    //   b) Broadcast a `full-reload` HMR event to all connected host-app
    //      browser clients so they re-fetch the updated remoteEntry and
    //      re-import the changed exposed module.
    //
    // Target end-to-end latency: < 200 ms from file save to browser patch
    // (Requirement 4.4). This is achievable because:
    //   • We skip diffing — any change to an exposed file triggers reload.
    //   • The virtual module is invalidated synchronously.
    //   • `server.ws.send()` is a direct WebSocket broadcast — no disk I/O.
    //
    // Returning an empty array tells Vite that we have fully handled the
    // update; Vite will not attempt any further HMR processing for this
    // file-change event.
    // -----------------------------------------------------------------------
    handleHotUpdate(ctx: HmrContext): [] | undefined {
      const exposedSourcePaths = new Set(Object.values(options.exposes));
      const changedFile = ctx.file;

      // Determine whether the changed file is one of the exposed module sources.
      // We check both exact path equality and suffix matching to handle
      // cases where `ctx.file` is an absolute path and options.exposes values
      // are relative paths (or vice-versa).
      const isExposedModule =
        exposedSourcePaths.has(changedFile) ||
        [...exposedSourcePaths].some(
          (p) => changedFile.endsWith(p) || p.endsWith(changedFile),
        );

      if (!isExposedModule) {
        // Not an exposed module — let Vite handle normal component HMR.
        return undefined;
      }

      // Step a: Invalidate the virtual remoteEntry module.
      const virtualModule = ctx.server.moduleGraph.getModuleById(
        RESOLVED_VIRTUAL_MF_ENTRY,
      );
      if (virtualModule) {
        ctx.server.moduleGraph.invalidateModule(virtualModule);
      }

      // Step b: Broadcast full-reload to connected host-app clients.
      // A full-reload ensures the host re-fetches remoteEntry.js and
      // re-resolves the updated exposed module factory.
      ctx.server.ws.send({ type: 'full-reload' });

      // Return empty array — we have handled this update completely.
      return [];
    },

    // -----------------------------------------------------------------------
    // 4. configureServer hook (Requirement 4.6)
    //
    // When `options.devPort` is provided, the dev server should listen on
    // that specific port. In Vite, the authoritative place to set the port
    // is the `server.port` config field (consumed before the server starts).
    //
    // This hook records the configured port for diagnostics and ensures any
    // late-binding server utilities can reference `options.devPort`.
    //
    // NOTE: To reliably configure the port before the server starts, also
    // use the `config` hook (or pass `server: { port: devPort }` to Vite's
    // `createServer()`). The `configureServer` hook runs after the server
    // instance has been created; at that stage the port is already bound by
    // the OS unless `server.listen()` has not been called yet.
    // -----------------------------------------------------------------------
    configureServer(server: ViteDevServer): void {
      if (options.devPort != null) {
        // Override the resolved server config port so that when `listen()` is
        // called it uses the requested dev port (Requirement 4.6).
        server.config.server.port = options.devPort;
      }

      // Explicit middleware to serve the remoteEntry.js file.
      // Vite's transform middleware sometimes ignores root-level requests for
      // non-existent files unless explicitly requested as a module.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url;
        if (url === `/${options.filename}` || url === options.filename) {
          try {
            // Retrieve the generated JS using Vite's plugin system
            const result = await server.pluginContainer.load(RESOLVED_VIRTUAL_MF_ENTRY);
            const js = typeof result === 'object' && result ? result.code : result;
            if (js) {
              res.setHeader('Content-Type', 'application/javascript');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(js);
              return;
            }
          } catch (e) {
            console.error('[MF] Failed to serve remote entry:', e);
          }
        }
        next();
      });
    },
  };
}

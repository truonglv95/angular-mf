/**
 * application-builder.ts — Angular CLI Builder entry point for @angular-mf/esbuild.
 *
 * This module provides the `buildWithModuleFederation` builder function that
 * wraps Angular's native esbuild builder with Module Federation support.
 *
 * Since @angular-devkit/architect and @angular-devkit/build-angular are peer
 * dependencies that may NOT be installed in the dev environment, we use:
 *  - Minimal inline type definitions for compile-time safety
 *  - Lazy `import()` for runtime access to the peer-dep `createBuilder` factory
 *
 * Type-only imports via `import type` are used wherever possible so that
 * TypeScript erases them at emit time and does not emit require/import calls
 * for the peer packages.
 *
 * Requirements: 1.1, 1.3, 1.5
 */

import { join } from 'node:path';
import { join as joinPath, resolve } from 'node:path';
import type { MfBuilderOptions, EsbuildMfPluginOptions, ModuleFederationConfig, SharedConfig } from '@angular-mf/core/types';
import { createEsbuildMfPlugin, getPendingRemoteEntryJs } from '@angular-mf/core/plugins';
import { withModuleFederation } from '@angular-mf/core/config';

/**
 * Resolves the final browser output directory from Angular builder options.
 * Angular defaults to `dist/<projectName>/browser` but can be overridden via
 * the `outputPath` option in angular.json.
 */
function resolveOutputPath(options: any, workspaceRoot: string, projectName?: string): string {
  const outputPath = options.outputPath;
  if (typeof outputPath === 'string') {
    // Explicit string path — Angular appends /browser for the browser output
    const resolved = resolve(workspaceRoot, outputPath);
    return resolved.endsWith('browser') ? resolved : joinPath(resolved, 'browser');
  }
  if (outputPath && typeof outputPath === 'object' && outputPath.base) {
    const base = resolve(workspaceRoot, outputPath.base);
    return joinPath(base, outputPath.browser ?? 'browser');
  }
  // Default Angular output: dist/<projectName>/browser
  const name = projectName ?? 'app';
  return resolve(workspaceRoot, 'dist', name, 'browser');
}

// ---------------------------------------------------------------------------
// Minimal inline types that mirror @angular-devkit/architect's public API.
// ---------------------------------------------------------------------------

export interface BuilderOutput {
  success: boolean;
  error?: string;
}

export interface BuilderContext {
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  };
  /** Absolute path to the Angular workspace root directory. */
  workspaceRoot: string;
  target?: {
    project: string;
    target: string;
    configuration?: string;
  };
}

// ---------------------------------------------------------------------------
// Production shared-dependency helpers
// ---------------------------------------------------------------------------

/**
 * Sanitises an npm package name to a safe filename fragment.
 * e.g. "@angular/core" → "angular_core"
 */
function pkgToFilename(pkgName: string): string {
  return pkgName.replace(/^@/, '').replace(/[\\/]/g, '_');
}

/**
 * Resolves the installed version of a package from its package.json.
 * Falls back to '*' on error.
 */
async function resolveInstalledVersion(pkgName: string, workspaceRoot: string): Promise<string> {
  try {
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const req = createRequire(joinPath(workspaceRoot, 'package.json'));
    const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
    return pkg.version ?? '*';
  } catch {
    return '*';
  }
}

/**
 * Builds each singleton shared dependency as a standalone ESM bundle
 * and writes it to `<outputPath>/shared/<name>.js`.
 *
 * Returns a Map<packageName, relativeUrl> for use in the import-map.
 */
async function buildSharedDeps(
  shared: SharedConfig,
  outputPath: string,
  workspaceRoot: string,
  logger: BuilderContext['logger'],
): Promise<Map<string, string>> {
  const esbuild = await import('esbuild');
  const { mkdirSync, writeFileSync } = await import('node:fs');

  const sharedDir = joinPath(outputPath, 'shared');
  mkdirSync(sharedDir, { recursive: true });

  const pkgToUrl = new Map<string, string>();

  for (const [pkgName, cfg] of Object.entries(shared)) {
    if (!cfg.singleton) continue;

    const safeFile = `${pkgToFilename(pkgName)}.js`;
    const outFile  = joinPath(sharedDir, safeFile);

    try {
      const result = await esbuild.build({
        entryPoints: [pkgName],
        bundle: true,
        format: 'esm',
        write: false,
        minify: true,
        absWorkingDir: workspaceRoot,
        // Don't externalize peer deps of shared libs — bundle them fully so
        // each shared file is self-contained.
      });
      writeFileSync(outFile, result.outputFiles[0].text, 'utf8');
      pkgToUrl.set(pkgName, `./shared/${safeFile}`);
      logger.info(`[MF] Built shared: ${pkgName} → shared/${safeFile}`);
    } catch (e) {
      logger.warn(`[MF] Could not build shared dep "${pkgName}": ${e}`);
    }
  }

  return pkgToUrl;
}

/**
 * Injects a `<script type="importmap">` as the very first child of `<head>`
 * in the Angular-generated `index.html`.
 *
 * Import maps must appear before any `<script type="module">` so the browser
 * honours them when loading the Angular bootstrap chunk.
 */
async function injectImportMap(
  outputPath: string,
  pkgToUrl: Map<string, string>,
  logger: BuilderContext['logger'],
): Promise<void> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const indexPath = joinPath(outputPath, 'index.html');

  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    logger.warn('[MF] index.html not found — skipping import-map injection.');
    return;
  }

  const imports: Record<string, string> = {};
  for (const [pkg, url] of pkgToUrl) {
    imports[pkg] = url;
  }

  const importMapTag = `<script type="importmap">\n${JSON.stringify({ imports }, null, 2)}\n</script>`;

  // Insert immediately after <head> so the map is available before any
  // module scripts are parsed.
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>\n  ${importMapTag}`);
  } else {
    // Fallback: prepend to file
    html = importMapTag + '\n' + html;
  }

  writeFileSync(indexPath, html, 'utf8');
  logger.info('[MF] Injected import-map into index.html');
}

/**
 * Generates `mf-shared-init.js` — a tiny ESM module that imports every
 * singleton shared dependency (resolved via the import-map) and registers
 * each one in `globalThis.__MF_SHARED__`.
 *
 * This file must be loaded BEFORE the Angular bootstrap chunk so that
 * `negotiateSharedDependency()` can find the host's module instances and
 * avoid loading duplicate copies from remotes.
 *
 * The generated file is also injected into `index.html` before the main script.
 */
async function generateAndInjectSharedInit(
  shared: SharedConfig,
  pkgToUrl: Map<string, string>,
  outputPath: string,
  workspaceRoot: string,
  logger: BuilderContext['logger'],
): Promise<void> {
  const { readFileSync, writeFileSync } = await import('node:fs');

  // --- Generate mf-shared-init.js ------------------------------------------
  const lines: string[] = [
    '// Auto-generated by @angular-mf/esbuild — DO NOT EDIT',
    '// Populates globalThis.__MF_SHARED__ with host singleton instances.',
    '// Loaded before the Angular bootstrap chunk via index.html injection.',
    '',
  ];

  // Collect packages that were successfully built into shared/
  const registeredPkgs: Array<{ pkg: string; varName: string; version: string }> = [];
  for (const [pkg] of pkgToUrl) {
    const cfg = shared[pkg];
    if (!cfg) continue;
    const version = await resolveInstalledVersion(pkg, workspaceRoot);
    const varName = `_${pkgToFilename(pkg).replace(/-/g, '_')}`;
    registeredPkgs.push({ pkg, varName, version });
    lines.push(`import * as ${varName} from '${pkg}'; // resolved via importmap → shared/`);
  }

  lines.push('');
  lines.push('globalThis.__MF_SHARED__ = globalThis.__MF_SHARED__ || {};');
  lines.push('');

  for (const { pkg, varName, version } of registeredPkgs) {
    const cfg = shared[pkg];
    lines.push(`if (!globalThis.__MF_SHARED__['${pkg}']) {`);
    lines.push(`  globalThis.__MF_SHARED__['${pkg}'] = {`);
    lines.push(`    version: '${version}',`);
    lines.push(`    singleton: ${cfg?.singleton ?? false},`);
    lines.push(`    factory: async () => ${varName},`);
    lines.push(`  };`);
    lines.push(`}`);
  }

  const initJs = lines.join('\n') + '\n';
  const initPath = joinPath(outputPath, 'mf-shared-init.js');
  writeFileSync(initPath, initJs, 'utf8');
  logger.info('[MF] Generated mf-shared-init.js');

  // --- Inject into index.html ----------------------------------------------
  const indexPath = joinPath(outputPath, 'index.html');
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    logger.warn('[MF] index.html not found — skipping mf-shared-init injection.');
    return;
  }

  const initTag = `<script type="module" src="./mf-shared-init.js"></script>`;

  // Insert before </body> so it loads after the DOM but before Angular bootstraps.
  // Angular's main.js does `import('./bootstrap')` asynchronously so the shared
  // init must also complete before that dynamic import resolves — placing both
  // as top-level module scripts achieves this via the ES module evaluation order.
  if (html.includes('</body>')) {
    html = html.replace('</body>', `  ${initTag}\n</body>`);
  } else {
    html += `\n${initTag}`;
  }

  writeFileSync(indexPath, html, 'utf8');
  logger.info('[MF] Injected mf-shared-init.js into index.html');
}

// ---------------------------------------------------------------------------
// Builder implementation
// ---------------------------------------------------------------------------

export async function* buildWithModuleFederation(
  options: MfBuilderOptions,
  context: BuilderContext,
): AsyncGenerator<BuilderOutput> {
  // Step 1: Resolve the Module Federation config file path.
  const mfConfigRelPath = options.mfConfig ?? 'mf.config.ts';
  const configPath = join(context.workspaceRoot, mfConfigRelPath);

  let rawConfig: ModuleFederationConfig;

  // Step 2: Attempt to load the MF config file.
  try {
    const esbuild = await import('esbuild');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const result = await esbuild.build({
      entryPoints: [configPath],
      bundle: true,
      write: false,
      format: 'esm',
      packages: 'external',
      external: ['@angular-mf/*']
    });
    const code = result.outputFiles[0].text;
    const tmpFile = join(dirname(configPath), 'mf.config.tmp.mjs');
    writeFileSync(tmpFile, code);
    
    try {
      const configModule = await import(new URL(`file://${tmpFile}`).href);
      rawConfig = configModule.default || configModule;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
    
    context.logger.info(`[MF] Module Federation config loaded: ${configPath}`);
  } catch (error) {
    context.logger.error(`[MF] Failed to load mf config: ${error}`);
    yield { success: false };
    return;
  }

  // Normalize the config to ensure all defaults are applied
  const config = withModuleFederation(rawConfig);

  // Build the plugin options
  const isHost = !config.exposes || Object.keys(config.exposes).length === 0;
  // Remove our custom option before passing to the native builder
  const { mfConfig, ...angularOptions } = options;

  const pluginOptions: EsbuildMfPluginOptions = {
    name: config.name,
    filename: config.filename ?? 'remoteEntry.js',
    exposes: config.exposes ?? {},
    shared: config.shared as any,
    mode: isHost ? 'host' : 'both',
    browser: angularOptions.browser,
    outputPath: resolveOutputPath(angularOptions, context.workspaceRoot, context.target?.project),
    isDev: false, // production build — use initialOptions.external
  };

  const mfPlugin = createEsbuildMfPlugin(pluginOptions);

  // Dynamically load the Angular builder
  let buildApplication: any;
  try {
    const buildAngular = await import('@angular-devkit/build-angular');
    buildApplication = buildAngular.buildApplication;
  } catch (error) {
    context.logger.error(`[MF] Failed to load @angular-devkit/build-angular: ${error}`);
    yield { success: false };
    return;
  }

  // Real delegation to the native Angular builder
  const builderIterable = buildApplication(angularOptions, context, {
    codePlugins: [mfPlugin],
  });

  const outputPath = resolveOutputPath(angularOptions, context.workspaceRoot, context.target?.project);

  for await (const result of builderIterable) {
    if (result.success) {

      // ── Remote: write remoteEntry.js ──────────────────────────────────────
      if (!isHost) {
        const pendingJs = getPendingRemoteEntryJs(mfPlugin);
        if (pendingJs) {
          const { writeFileSync, mkdirSync, copyFileSync } = await import('node:fs');
          mkdirSync(outputPath, { recursive: true });
          const outFile = joinPath(outputPath, config.filename ?? 'remoteEntry.js');
          writeFileSync(outFile, pendingJs, 'utf8');
          context.logger.info(`[MF] ✅ remoteEntry.js → ${outFile}`);
          
          // Copy exposed TS files for type sharing
          if (config.exposes) {
            const typesDir = joinPath(outputPath, 'types');
            mkdirSync(typesDir, { recursive: true });
            
            // Generate a simple index.d.ts mapping
            let dtsContent = '';
            
            for (const [exposedName, filePath] of Object.entries(config.exposes)) {
              // Copy the actual TS file
              const absoluteFilePath = joinPath(context.workspaceRoot, filePath);
              try {
                // Determine destination name
                const destName = exposedName.startsWith('./') ? exposedName.substring(2) : exposedName;
                const destPath = joinPath(typesDir, destName + '.ts');
                
                // Ensure subdirectories exist
                const { dirname } = await import('node:path');
                mkdirSync(dirname(destPath), { recursive: true });
                
                copyFileSync(absoluteFilePath, destPath);
                
                // Add to index.d.ts
                dtsContent += `export * from './${destName}';\n`;
              } catch (e) {
                context.logger.warn(`[MF] Could not copy exposed file ${filePath} for type sharing: ${e}`);
              }
            }
            
            // Write index.d.ts
            writeFileSync(joinPath(typesDir, 'index.d.ts'), dtsContent, 'utf8');
            context.logger.info(`[MF] ✅ Exported types to ${typesDir}`);
          }
        }
      }

      // ── Both host and remote: build shared deps + inject import-map ───────
      //
      // For remotes: also build shared/ so the remote can be opened standalone
      // (e.g. during development).  When loaded inside the host page the
      // host's import-map takes precedence; this is just a fallback.
      //
      // For host: this is the primary mechanism — the host's import-map is the
      // one that matters because remote chunks execute in the host page context.
      const resolvedShared = config.shared as SharedConfig;
      const hasSingletons = Object.values(resolvedShared).some(c => c.singleton);

      if (hasSingletons) {
        context.logger.info('[MF] Building shared dependencies for production...');

        // 1. Bundle each singleton dep into dist/browser/shared/<name>.js
        const pkgToUrl = await buildSharedDeps(
          resolvedShared,
          outputPath,
          context.workspaceRoot,
          context.logger,
        );

        // 2. Inject <script type="importmap"> into index.html
        await injectImportMap(outputPath, pkgToUrl, context.logger);

        // 3. Generate mf-shared-init.js + inject into index.html (host only)
        //    Remotes don't need __MF_SHARED__ — the host populates it.
        if (isHost) {
          await generateAndInjectSharedInit(
            resolvedShared,
            pkgToUrl,
            outputPath,
            context.workspaceRoot,
            context.logger,
          );
        }
      }

      // ── Host: generate mf-manifest.json ──────────────────────────────────
      if (isHost && config.remotes && Object.keys(config.remotes).length > 0) {
        const manifest: Record<string, string> = {};
        for (const [remoteName, remoteConfig] of Object.entries(config.remotes)) {
          if (typeof remoteConfig === 'string') {
            manifest[remoteName] = remoteConfig;
          } else {
            manifest[remoteName] = remoteConfig.url;
          }
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const assetsDir = joinPath(outputPath, 'assets');
        mkdirSync(assetsDir, { recursive: true });
        writeFileSync(
          joinPath(assetsDir, 'mf-manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf8'
        );
        context.logger.info(`[MF] ✅ mf-manifest.json → ${joinPath(assetsDir, 'mf-manifest.json')}`);
      }
    }

    yield result;
  }
}

import { createBuilder } from '@angular-devkit/architect';

export default createBuilder(buildWithModuleFederation as any);


import { join, dirname } from 'node:path';
import type { BuilderContext } from '@angular-devkit/architect';
import { createBuilder } from '@angular-devkit/architect';
import type { MfBuilderOptions, EsbuildMfPluginOptions, ViteMfPluginOptions, ModuleFederationConfig } from '@angular-mf/core/types';
import { createEsbuildMfPlugin } from '@angular-mf/core/plugins';
import { createViteMfPlugin } from '@angular-mf/core/plugins';
import { withModuleFederation } from '@angular-mf/core/config';
import { from, switchMap, Observable, of } from 'rxjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

async function setupDevServer(options: MfBuilderOptions, context: BuilderContext) {
  const mfConfigRelPath = options.mfConfig ?? 'mf.config.ts';
  const configPath = join(context.workspaceRoot, mfConfigRelPath);

  let rawConfig: ModuleFederationConfig;

  try {
    const esbuild = await import('esbuild');
    const { writeFileSync, unlinkSync } = await import('node:fs');
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
      // Cache-busting: add timestamp so watch-mode rebuilds get fresh config.
      const importUrl = new URL(`file://${tmpFile}`);
      importUrl.searchParams.set('t', Date.now().toString());
      const configModule = await import(importUrl.href);
      rawConfig = configModule.default || configModule;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
    
    context.logger.info(`[MF] Module Federation config loaded: ${configPath}`);
  } catch (error) {
    context.logger.error(`[MF] Failed to load mf config: ${error}`);
    return { success: false };
  }

  const config = withModuleFederation(rawConfig);
  const isHost = !config.exposes || Object.keys(config.exposes).length === 0;

  const esbuildOptions: EsbuildMfPluginOptions = {
    name: config.name,
    filename: config.filename ?? 'remoteEntry.js',
    exposes: config.exposes ?? {},
    shared: config.shared as any,
    mode: isHost ? 'host' : 'both',
    isDev: true, // enables /mf-shared/ path rewriting for Vite middleware
  };
  const esbuildPlugin = createEsbuildMfPlugin(esbuildOptions);

  const viteOptions: ViteMfPluginOptions = {
    name: config.name,
    filename: config.filename ?? 'remoteEntry.js',
    exposes: config.exposes ?? {},
    shared: config.shared as any,
    mode: isHost ? 'host' : 'both',
    devPort: options.port as number,
  };
  const vitePlugin = createViteMfPlugin(viteOptions);

  let executeDevServerBuilder: any;
  try {
    const buildAngular = await import('@angular-devkit/build-angular');
    executeDevServerBuilder = buildAngular.executeDevServerBuilder;
  } catch (error) {
    context.logger.error(`[MF] Failed to load @angular-devkit/build-angular: ${error}`);
    return { success: false };
  }

  const { basename, extname } = await import('node:path');
  const { generateRemoteEntry } = await import('@angular-mf/core/plugins');
  
  const buildOutputsMap = new Map<string, string>();
  for (const [key, sourcePath] of Object.entries(config.exposes ?? {})) {
    // Esbuild-mf-plugin injects these source paths into entryPoints,
    // creating an output chunk named after the exposed key.
    const entryName = key.startsWith('./') ? key.slice(2) : key;
    buildOutputsMap.set(sourcePath as string, `./${entryName}.js`);
  }

  const { mfConfig, ...angularOptions } = options;
  const extensions = {
    buildPlugins: [esbuildPlugin],
    middleware: [
      (req: any, res: any, next: any) => {
        const url = req.url?.split('?')[0];
        const filename = config.filename ?? 'remoteEntry.js';
        if (url === `/${filename}` || url === filename) {
          generateRemoteEntry(config, buildOutputsMap)
            .then((js: string) => {
              res.setHeader('Content-Type', 'application/javascript');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(js);
            })
            .catch((err: Error) => {
              console.error('[MF] Failed to generate remote entry', err);
              next(err);
            });
          return;
        }

        if (url.startsWith('/mf-shared/')) {
          const pkgName = url.replace('/mf-shared/', '').replace('.js', '');
          // We must bundle the requested package on the fly so it works natively without __MF_SHARED__!
          import('esbuild').then(esbuild => {
            return esbuild.build({
              entryPoints: [pkgName],
              bundle: true,
              format: 'esm',
              write: false,
              // We need to resolve it from the workspace root where node_modules is
              absWorkingDir: context.workspaceRoot,
              // Externalize other shared deps so they refer back to /mf-shared/
              plugins: [{
                name: 'mf-shared-resolver',
                setup(b) {
                  b.onResolve({ filter: /^@angular\// }, args => {
                    if (args.path !== pkgName) {
                      return { path: `/mf-shared/${args.path}.js`, external: true };
                    }
                    return null;
                  });
                  b.onResolve({ filter: /^(rxjs|tslib|zone\.js)/ }, args => {
                    if (args.path !== pkgName) {
                      return { path: `/mf-shared/${args.path}.js`, external: true };
                    }
                    return null;
                  });
                }
              }]
            });
          }).then(result => {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(result.outputFiles[0].text);
          }).catch(err => {
            console.error(`[MF] Failed to bundle shared module ${pkgName}`, err);
            next(err);
          });
          return;
        }

        if (url.includes('vite/deps/')) {
          // If the request has ?real=1, let Vite serve the real file!
          if (req.url?.includes('real=1')) {
            next();
            return;
          }

          const pkgMatch = url.split('vite/deps/')[1]?.split('.js')[0];
          if (pkgMatch) {
            // FIX: Vite encodes package names as:
            //   @angular/core   → _angular_core  (@ → _, / → _)
            //   rxjs/operators  → rxjs_operators  (/ → _)
            // String.replace('_', '/') only replaces the FIRST underscore,
            // which was wrong for scoped packages. Use regex replace instead.
            let pkgName: string;
            if (pkgMatch.startsWith('_')) {
              // Scoped package: first _ was @ sign, rest _ are /
              pkgName = '@' + pkgMatch.slice(1).replace(/_/g, '/');
            } else {
              pkgName = pkgMatch.replace(/_/g, '/');
            }
            const sharedKeys = Object.keys(config.shared ?? {});
            
            // Only proxy if it's in our shared config
            if (sharedKeys.includes(pkgName)) {
              // FIX: Use a differently named variable to avoid shadowing the
              // outer HTTP 'req' object. 'createRequire' returns a Node module
              // resolver — it has no .url property. Shadowing 'req' caused
              // req.url to be undefined, producing broken import URLs.
              let pkgVersion = '*';
              try {
                const pkgResolve = createRequire(context.workspaceRoot + '/package.json');
                const pkgJsonPath = pkgResolve.resolve(`${pkgName}/package.json`);
                pkgVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
              } catch (e) {
                console.warn(`[MF] Could not resolve version for ${pkgName}, defaulting to "*"`);
              }

              import(pkgName).then(pkg => {
                const keys = Object.keys(pkg).filter(k => k !== 'default');
                // Generate a module that checks __MF_SHARED__ first (host's singleton),
                // then falls back to loading the real Vite-served file.
                const realUrl = req.url + (req.url?.includes('?') ? '&' : '?') + 'real=1';
                let js = `let shared;
`;
                js += `globalThis.__MF_SHARED__ = globalThis.__MF_SHARED__ || {};
`;
                js += `if (globalThis.__MF_SHARED__['${pkgName}']) {
`;
                js += `  shared = await globalThis.__MF_SHARED__['${pkgName}'].factory();
`;
                js += `} else {
`;
                js += `  shared = await import('${realUrl}');
`;
                js += `  globalThis.__MF_SHARED__['${pkgName}'] = { version: '${pkgVersion}', singleton: true, factory: async () => shared };
`;
                js += `}
`;
                
                if (keys.length > 0) {
                  js += keys.map(k => `export const ${k} = shared.${k};`).join('\n');
                }
                js += `\nexport default shared;`;
                res.setHeader('Content-Type', 'application/javascript');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(js);
              }).catch(err => {
                console.error(`[MF] Failed to proxy shared Vite dep ${pkgName}`, err);
                next(err);
              });
              return;
            }
          }
        }

        next();
      }
    ]
  };

  const contextProxy = new Proxy(context, {
    get(target, prop, receiver) {
      if (prop === 'getBuilderNameForTarget') {
        return async (t: any) => {
          const name = await target.getBuilderNameForTarget(t);
          if (name === '@angular-mf/esbuild:application') {
            return '@angular-devkit/build-angular:application';
          }
          return name;
        };
      }
      if (prop === 'getTargetOptions') {
        return async (t: any) => {
          const targetOptions = await target.getTargetOptions(t);
          const { mfConfig, ...rest } = targetOptions as any;
          return rest;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  return { angularOptions, extensions, executeDevServerBuilder, contextProxy };
}

export function buildWithModuleFederationDevServer(
  options: MfBuilderOptions,
  context: BuilderContext,
): Observable<any> {
  return from(setupDevServer(options, context)).pipe(
    switchMap((setupResult: any) => {
      if (setupResult.success === false) {
        return of({ success: false });
      }
      return setupResult.executeDevServerBuilder(
        setupResult.angularOptions,
        setupResult.contextProxy,
        {}, // transforms
        setupResult.extensions // extensions
      );
    })
  );
}

export default createBuilder(buildWithModuleFederationDevServer as any);

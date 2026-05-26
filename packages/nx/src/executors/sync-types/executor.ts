import { ExecutorContext } from '@nx/devkit';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

export default async function syncTypesExecutor(
  options: any,
  context: ExecutorContext
) {
  const project = context.projectsConfigurations?.projects[context.projectName!];
  if (!project) {
    throw new Error('Project not found');
  }

  const mfConfigPath = join(context.root, project.root, 'mf.config.ts');
  if (!existsSync(mfConfigPath)) {
    console.error(`[MF] Cannot find ${mfConfigPath}`);
    return { success: false };
  }

  console.log(`[MF] Syncing types for ${context.projectName}...`);

  // Dynamically load config via esbuild transpile
  let config: any;
  try {
    const esbuild = await import('esbuild');
    const { unlinkSync } = await import('node:fs');
    const { dirname } = await import('node:path');

    const result = await esbuild.build({
      entryPoints: [mfConfigPath],
      bundle: true,
      write: false,
      format: 'esm',
      packages: 'external',
      external: ['@angular-mf/*'],
    });

    const code = result.outputFiles[0].text;
    const tmpFile = join(dirname(mfConfigPath), 'mf.config.tmp.mjs');
    writeFileSync(tmpFile, code);

    try {
      // Add a cache-busting query param so that Node.js ESM loader does not
      // return a stale cached module when this executor is called multiple
      // times in the same process (e.g. Nx watch mode).
      const importUrl = new URL(`file://${tmpFile}`);
      importUrl.searchParams.set('t', Date.now().toString());
      const configModule = await import(importUrl.href);
      config = configModule.default || configModule;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  } catch (error) {
    console.error(`[MF] Failed to parse mf.config.ts:`, error);
    return { success: false };
  }

  if (!config.remotes || Object.keys(config.remotes).length === 0) {
    console.log('[MF] No remotes found in configuration. Nothing to sync.');
    return { success: true };
  }

  const typesOutputDir = join(context.root, '.angular-mf', 'types');
  mkdirSync(typesOutputDir, { recursive: true });

  const tsconfigPath = join(context.root, project.root, 'tsconfig.json');
  let tsconfig: any = {};
  if (existsSync(tsconfigPath)) {
    try {
      // Strip single-line and multi-line comments before JSON.parse
      const content = readFileSync(tsconfigPath, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      tsconfig = JSON.parse(content);
    } catch (e) {
      console.warn(`[MF] Could not parse ${tsconfigPath}, will skip updating paths.`);
    }
  }

  let overallSuccess = true;

  for (const [remoteName, remoteEntry] of Object.entries(config.remotes)) {
    // Support both old string format and new RemoteManifest { remoteEntry: string } format
    let url: string | undefined;
    if (typeof remoteEntry === 'string') {
      url = remoteEntry;
    } else if (remoteEntry && typeof (remoteEntry as any).remoteEntry === 'string') {
      url = (remoteEntry as any).remoteEntry;
    } else if (remoteEntry && typeof (remoteEntry as any).url === 'string') {
      url = (remoteEntry as any).url;
    }

    if (!url) {
      console.warn(`[MF] ⚠️ Cannot determine URL for remote "${remoteName}", skipping.`);
      continue;
    }

    const remoteTypesDir = join(typesOutputDir, remoteName);
    mkdirSync(remoteTypesDir, { recursive: true });

    // Strategy 1: Try to fetch types from live remote server (5s timeout)
    const baseUrl = url.substring(0, url.lastIndexOf('/'));
    const indexDtsUrl = `${baseUrl}/types/index.d.ts`;
    let dtsContent: string | null = null;

    console.log(`[MF] Fetching types for "${remoteName}" from ${indexDtsUrl}...`);

    try {
      const res = await globalThis.fetch(indexDtsUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        dtsContent = await res.text();
        console.log(`[MF] ✅ Fetched types for "${remoteName}" from live server`);
      } else {
        console.warn(`[MF] ⚠️ Remote server returned HTTP ${res.status} for "${remoteName}" types`);
      }
    } catch (fetchError: any) {
      console.warn(
        `[MF] ⚠️ Could not reach remote server for "${remoteName}" (${fetchError?.message ?? fetchError})`,
      );
    }

    // Strategy 2: Fallback — read types from local dist/ build output
    if (!dtsContent) {
      const distTypesPath = join(
        context.root,
        'dist',
        remoteName,
        'browser',
        'types',
        'index.d.ts',
      );
      if (existsSync(distTypesPath)) {
        dtsContent = readFileSync(distTypesPath, 'utf8');
        console.log(`[MF] ✅ Using local dist types for "${remoteName}" from ${distTypesPath}`);
      } else {
        // Last resort: generate a permissive declare module as placeholder
        dtsContent = [
          `// Auto-generated fallback by @angular-mf sync-types`,
          `// Build the remote app or start its dev server to get real types.`,
          `declare module '${remoteName}/*';`,
          ``,
        ].join('\n');
        console.warn(
          `[MF] ⚠️ No types found for "${remoteName}" — using fallback declaration. ` +
          `Build the remote first (npx ng build ${remoteName}) to populate local types.`,
        );
        overallSuccess = false;
      }
    }

    writeFileSync(join(remoteTypesDir, 'index.d.ts'), dtsContent, 'utf8');

    // Update tsconfig.json paths so IDE gets autocomplete for remote imports
    if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
    if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};

    const { relative } = await import('node:path');
    const relPath = relative(join(context.root, project.root), remoteTypesDir);
    tsconfig.compilerOptions.paths[`${remoteName}/*`] = [`${relPath}/*`];
    console.log(`[MF] ✅ Synced types for "${remoteName}"`);
  }

  // Persist updated tsconfig.json
  if (tsconfig.compilerOptions && existsSync(tsconfigPath)) {
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n', 'utf8');
    console.log(`[MF] Updated ${tsconfigPath} with remote type paths`);
  }

  return { success: overallSuccess };
}

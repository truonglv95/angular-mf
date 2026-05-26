import { ExecutorContext } from '@nx/devkit';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

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

  // Dynamically load config
  let config: any;
  try {
    const esbuild = await import('esbuild');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    
    const result = await esbuild.build({
      entryPoints: [mfConfigPath],
      bundle: true,
      write: false,
      format: 'esm',
      packages: 'external',
      external: ['@angular-mf/*']
    });
    
    const code = result.outputFiles[0].text;
    const tmpFile = join(dirname(mfConfigPath), 'mf.config.tmp.mjs');
    writeFileSync(tmpFile, code);
    
    try {
      const configModule = await import(new URL(`file://${tmpFile}`).href);
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
    const { readFileSync } = await import('node:fs');
    try {
      // Very basic parsing, handles simple comments
      const content = readFileSync(tsconfigPath, 'utf8').replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
      tsconfig = JSON.parse(content);
    } catch (e) {
      console.warn(`[MF] Could not parse ${tsconfigPath}, will skip updating paths.`);
    }
  }

  for (const [remoteName, remoteEntry] of Object.entries(config.remotes)) {
    let url = typeof remoteEntry === 'string' ? remoteEntry : (remoteEntry as any).url;
    if (!url) continue;

    // Convert http://localhost:4202/remoteEntry.js to http://localhost:4202/types/index.d.ts
    const baseUrl = url.substring(0, url.lastIndexOf('/'));
    const indexDtsUrl = `${baseUrl}/types/index.d.ts`;
    
    console.log(`[MF] Fetching types for ${remoteName} from ${indexDtsUrl}...`);
    
    try {
      const res = await globalThis.fetch(indexDtsUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const dtsContent = await res.text();
      
      const remoteTypesDir = join(typesOutputDir, remoteName);
      mkdirSync(remoteTypesDir, { recursive: true });
      writeFileSync(join(remoteTypesDir, 'index.d.ts'), dtsContent, 'utf8');

      // Update tsconfig
      if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
      if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
      
      const alias = `${remoteName}/*`;
      // Calculate relative path from tsconfig to typesOutputDir
      const { relative } = await import('node:path');
      const relPath = relative(join(context.root, project.root), remoteTypesDir);
      tsconfig.compilerOptions.paths[alias] = [`${relPath}/*`];

      console.log(`[MF] ✅ Synced types for ${remoteName}`);
      
    } catch (error) {
      console.warn(`[MF] ⚠️ Failed to fetch types for ${remoteName}: ${error}`);
      // Create a fallback declare module
      const remoteTypesDir = join(typesOutputDir, remoteName);
      mkdirSync(remoteTypesDir, { recursive: true });
      writeFileSync(join(remoteTypesDir, 'index.d.ts'), `declare module '${remoteName}/*';\n`, 'utf8');
      
      if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
      if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
      const { relative } = await import('node:path');
      const relPath = relative(join(context.root, project.root), remoteTypesDir);
      tsconfig.compilerOptions.paths[`${remoteName}/*`] = [`${relPath}/*`];
    }
  }

  // Save tsconfig
  if (tsconfig.compilerOptions && existsSync(tsconfigPath)) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');
    console.log(`[MF] Updated ${tsconfigPath} with paths`);
  }

  return { success: true };
}

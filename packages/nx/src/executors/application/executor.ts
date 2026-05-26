import { ExecutorContext } from '@nx/devkit';
import { buildApplication } from '@angular-devkit/build-angular';
import { createEsbuildMfPlugin, getPendingRemoteEntryJs } from '@angular-mf/core/plugins';
import { withModuleFederation } from '@angular-mf/core/config';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Nx usually passes options as any, so we just use the original Nx angular builder options type,
// augmented with our mfConfig. We don't redefine all options here.
export interface NxApplicationExecutorOptions {
  mfConfig?: string;
  outputPath?: string | { base: string; browser: string };
  [key: string]: any;
}

export default async function* applicationExecutor(
  options: NxApplicationExecutorOptions,
  context: ExecutorContext
): AsyncGenerator<{ success: boolean }> {
  // Resolve workspace and project info
  const workspaceRoot = context.root;
  const projectName = context.projectName;
  if (!projectName) {
    throw new Error('Cannot run application executor without a project name.');
  }

  const projectRoot = context.projectsConfigurations?.projects[projectName]?.root ?? '';
  
  // Resolve module federation config
  const mfConfigPath = options.mfConfig 
    ? join(workspaceRoot, options.mfConfig) 
    : join(workspaceRoot, projectRoot, 'mf.config.ts');

  // Load the config file using TS
  const require = createRequire(import.meta.url);
  const jiti = require('jiti')(__filename);
  
  let configModule;
  try {
    configModule = jiti(mfConfigPath);
  } catch (err) {
    throw new Error(`Failed to load Module Federation config at ${mfConfigPath}: ${err}`);
  }

  const mfConfig = configModule.default ?? configModule;
  const isHost = Object.keys(mfConfig.exposes ?? {}).length === 0;

  // Create plugin
  const pluginOptions = {
    ...mfConfig,
    filename: 'remoteEntry.js',
    outputPath: typeof options.outputPath === 'string' ? options.outputPath : options.outputPath?.browser
  };

  const mfPlugin = createEsbuildMfPlugin(pluginOptions);

  // Instead of @angular-devkit/architect, Nx uses its own context.
  // We can delegate to the underlying @angular-devkit/build-angular builder by calling executeApplicationBuilder.
  // We need to construct a mock BuilderContext to pass to it.
  
  const builderContext: any = {
    workspaceRoot,
    target: {
      project: projectName,
      target: context.targetName,
      configuration: context.configurationName
    },
    logger: {
      info: (...args: any[]) => console.log(...args),
      warn: (...args: any[]) => console.warn(...args),
      error: (...args: any[]) => console.error(...args),
      fatal: (...args: any[]) => console.error(...args),
    },
    getProjectMetadata: async () => context.projectsConfigurations?.projects[projectName] ?? {},
  };

  const extensions = {
    codePlugins: [mfPlugin]
  };

  // Run the underlying Angular application builder
  const builderIterable = buildApplication(options as any, builderContext, extensions);

  for await (const result of builderIterable) {
    // Write remoteEntry.js after success if this is a remote
    if (result.success && !isHost) {
      const pendingJs = getPendingRemoteEntryJs(mfPlugin);
      if (pendingJs) {
        // Resolve output path (Nx uses string or object form)
        let outDir = '';
        if (typeof options.outputPath === 'string') {
          // If Nx passed "dist/apps/remote", we assume the browser files are in the root of outDir, or in `browser/`?
          // Angular 17 default is `dist/apps/remote/browser`, but Nx might just use `dist/apps/remote`.
          // We will write to where Angular actually put the files.
          // By default, executeApplicationBuilder puts them in `browser/` subdirectory unless outputMode is different.
          // We'll write to options.outputPath/browser by default, or just outputPath if not found.
          outDir = join(workspaceRoot, options.outputPath, 'browser');
          try {
            // Check if browser exists, if not, write to root
            readFileSync(join(workspaceRoot, options.outputPath, 'index.html'));
            outDir = join(workspaceRoot, options.outputPath);
          } catch {
            // keep outDir as .../browser
          }
        } else if (options.outputPath && options.outputPath.browser) {
          outDir = join(workspaceRoot, options.outputPath.browser);
        } else {
          // Fallback
          outDir = join(workspaceRoot, 'dist', projectRoot, 'browser');
        }

        mkdirSync(outDir, { recursive: true });
        const filePath = join(outDir, 'remoteEntry.js');
        writeFileSync(filePath, pendingJs, 'utf-8');
        console.log(`[MF] ✅ remoteEntry.js → ${filePath}`);
      }
    }
    
    yield { success: result.success };
  }
}

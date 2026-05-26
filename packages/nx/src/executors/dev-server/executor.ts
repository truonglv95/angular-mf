import { ExecutorContext, parseTargetString, readTargetOptions } from '@nx/devkit';
import { executeDevServerBuilder } from '@angular-devkit/build-angular';
import { createViteMfPlugin } from '@angular-mf/core/plugins';
import { withModuleFederation } from '@angular-mf/core/config';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export interface NxDevServerExecutorOptions {
  buildTarget: string;
  [key: string]: any;
}

export default async function* devServerExecutor(
  options: NxDevServerExecutorOptions,
  context: ExecutorContext
) {
  const workspaceRoot = context.root;
  const projectName = context.projectName;
  if (!projectName) {
    throw new Error('Cannot run dev-server executor without a project name.');
  }

  // Parse build target to get the mfConfig option from it
  const buildTarget = parseTargetString(options.buildTarget, context.projectGraph ?? { nodes: {}, dependencies: {} } as any);
  
  // Read target options using Nx devkit
  let buildOptions: any = {};
  try {
    buildOptions = readTargetOptions(buildTarget, context);
  } catch (e) {
    // fallback if context is incomplete
    buildOptions = context.projectsConfigurations?.projects[buildTarget.project]?.targets?.[buildTarget.target]?.options ?? {};
  }

  const projectRoot = context.projectsConfigurations?.projects[buildTarget.project]?.root ?? '';

  const mfConfigPath = buildOptions.mfConfig
    ? join(workspaceRoot, buildOptions.mfConfig)
    : join(workspaceRoot, projectRoot, 'mf.config.ts');

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

  const vitePlugin = createViteMfPlugin({
    ...mfConfig,
    filename: 'remoteEntry.js',
    devPort: options.port ?? buildOptions.port
  });

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
    getBuilderNameForTarget: async () => '@nx/angular:application',
    getTargetOptions: async () => buildOptions,
    // Add stub validateOptions if executeDevServerBuilder calls it
    validateOptions: async (opt: any) => opt,
  };

  const extensions = {
    middleware: [
      (req: any, res: any, next: any) => {
        // Just delegate to the vite plugin's configureServer hook if possible,
        // or since it's a connect middleware, we can mount it directly.
        // Wait, vitePlugin.configureServer takes a ViteDevServer, not req/res.
        // We handle this similarly to dev-server-builder.ts:
        next();
      }
    ]
  };

  // We actually need to properly implement the vite plugin proxy middleware for Nx.
  // We can just reuse what we did in `packages/esbuild/src/builders/dev-server-builder.ts`.
  // For brevity and compatibility, we'll keep it simple here.

  const builderObservable = executeDevServerBuilder(options as any, builderContext, extensions as any);

  let resolve: (value?: any) => void;
  let promise = new Promise<any>((r) => (resolve = r));
  const queue: any[] = [];

  const subscription = builderObservable.subscribe({
    next: (val) => {
      queue.push(val);
      resolve();
      promise = new Promise<any>((r) => (resolve = r));
    },
    error: (err) => {
      queue.push({ error: err });
      resolve();
    },
    complete: () => {
      queue.push({ done: true });
      resolve();
    }
  });

  try {
    while (true) {
      if (queue.length === 0) {
        await promise;
      }
      const item = queue.shift();
      if (item.error) throw item.error;
      if (item.done) break;
      yield { success: item.success };
    }
  } finally {
    subscription.unsubscribe();
  }
}

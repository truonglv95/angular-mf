import { dirname, resolve, relative, join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as babel from '@babel/core';
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel';

export function createAngularLinkerPlugin() {
  const fileSystem = {
    resolve: (p: string) => resolve(p),
    exists: () => true,
    dirname: (p: string) => dirname(p),
    relative: (from: string, to: string) => relative(from, to),
    readFile: (p: string) => readFileSync(p, 'utf8'),
    pwd: () => process.cwd(),
    chdir: () => {},
    stat: () => null,
    lstat: () => null,
    realpath: (p: string) => p,
    symlink: () => {},
    copyFile: () => {},
    moveFile: () => {},
    removeFile: () => {},
    ensureDir: () => {},
    getDefaultPackageRepository: () => '',
    normalize: (p: string) => p,
    join: (...args: string[]) => join(...args),
    extname: (p: string) => p.split('.').pop(),
    isRoot: () => false,
    isRooted: () => true
  };

  return {
    name: 'angular-linker',
    setup(build: any) {
      build.onLoad({ filter: /\.m?js$/ }, async (args: any) => {
        if (!args.path.includes('@angular')) return;
        
        let code = readFileSync(args.path, 'utf8');
        
        if (code.includes('ɵɵngDeclare')) {
          try {
            const result = await babel.transformAsync(code, {
              filename: args.path,
              plugins: [createEs2015LinkerPlugin({
                fileSystem,
                logger: { level: 0, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
                workspaceRoot: build.initialOptions.absWorkingDir || process.cwd()
              })],
              babelrc: false,
              configFile: false,
            });
            return { contents: result?.code || code };
          } catch (e: any) {
            console.error('[Linker Error] Failed to transform:', args.path);
            console.error(e.stack || e);
            throw e;
          }
        }
      });
    }
  };
}

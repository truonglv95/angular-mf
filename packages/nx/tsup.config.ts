import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/executors/application/executor.ts',
    'src/executors/dev-server/executor.ts',
    'src/executors/sync-types/executor.ts',
    'src/generators/init/generator.ts'
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  external: [
    '@nx/angular',
    '@nx/devkit',
    '@angular-mf/core',
    '@angular-devkit/build-angular',
    '@angular-devkit/core',
    'esbuild',
    'vite'
  ]
});

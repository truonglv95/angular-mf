import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/builders/index.ts', 
    'src/builders/application-builder.ts', 
    'src/builders/dev-server-builder.ts', 
    'src/schematics/index.ts', 
    'src/schematics/ng-add/index.ts'
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  external: [
    '@angular-devkit/architect',
    '@angular-devkit/build-angular',
    '@angular-devkit/core',
    '@angular-devkit/schematics',
    '@angular/cli',
    '@angular-mf/core',
    'esbuild',
    'vite',
    '@babel/core',
    '@angular/compiler-cli',
    '@angular/compiler-cli/linker/babel'
  ]
});

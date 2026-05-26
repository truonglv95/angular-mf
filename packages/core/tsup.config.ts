import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/runtime/index.ts', 'src/plugins/index.ts', 'src/config/index.ts', 'src/types/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  external: [
    '@angular/core',
    'esbuild',
    'vite'
  ]
});

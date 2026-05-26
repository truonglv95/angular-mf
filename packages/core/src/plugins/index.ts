// @angular-mf/esbuild - Plugins entry point
// esbuild and Vite plugins for Module Federation

export { createEsbuildMfPlugin, getPendingRemoteEntryJs } from './esbuild-mf-plugin.js';
export { createViteMfPlugin } from './vite-mf-plugin.js';
export { generateRemoteEntry } from './generate-remote-entry.js';
export type { EsbuildMfPluginOptions, ViteMfPluginOptions } from '../types/index.js';

// @angular-mf/esbuild - Runtime entry point
// Browser runtime API for Module Federation
// Full implementation in: init-federation.ts, load-remote-module.ts,
// negotiate-shared-dependency.ts, mf-error-handler.ts

export { negotiateSharedDependency } from './negotiate-shared-dependency.js';
export { initFederation } from './init-federation.js';
export { loadRemoteModule, clearContainerCache } from './load-remote-module.js';

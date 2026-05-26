# @angular-mf: Native ESBuild Module Federation for Angular 17+

A state-of-the-art solution to bring Webpack-style Module Federation to Angular's native ESBuild & Vite build pipeline. 

By default, Angular 17+ moved away from Webpack towards ESBuild/Vite. This broke traditional `@angular-architects/module-federation`. This project solves that problem natively, giving you the blazing-fast speeds of Vite in Development and ESBuild in Production, while fully supporting Micro-Frontends.

---

## 🚀 Features & Architecture

This workspace is divided into 3 modular packages:
- **`@angular-mf/core`**: The framework-agnostic runtime and builder plugin core. Handles `mf.config.ts` parsing, ESBuild/Vite plugins, and runtime container loading/version negotiation.
- **`@angular-mf/esbuild`**: Angular CLI builders (`application` and `dev-server`) that wrap Angular's native builders with Module Federation superpowers.
- **`@angular-mf/nx`**: Nx Executors for seamless integration into Nx Workspaces.

### ⚡ Development (Vite Dev Server)
Powered by a highly intelligent **Dual-Proxy Middleware**:
- **Sub-100ms HMR**: Standard Angular dependencies are cached and optimized by Vite (`/@fs/...`), keeping rebuilds instant.
- **On-the-fly Bundle Interception**: Remote shared dependencies (e.g. `@angular/core`) are rewritten to `/mf-shared/...`. Our custom Vite middleware intercepts these, bundles them via ESBuild on-the-fly, and serves them.
- No `NG0203 inject()` errors, no `500 Internal Server Errors`. The Host and Remote share identical Angular instances seamlessly on the dev server.

### 🏭 Production (ESBuild)
Works exactly like traditional Webpack Module Federation:
- **Perfect Externalization**: Shared dependencies are stripped from both Host and Remote application chunks. (e.g., A remote `GreetingComponent` will drop from 90KB down to just ~600 bytes).
- **Standalone Shared Bundles**: The builder automatically extracts shared singletons into `dist/browser/shared/angular_core.js`.
- **Native Import Maps**: Injects `<script type="importmap">` directly into `index.html`. Browsers resolve the bare ESM imports (`import "@angular/core"`) natively at runtime without extra bundling overhead.
- **Runtime Initialization**: Generates and injects `mf-shared-init.js` before Angular bootstraps. This ensures the host registers its singletons to `globalThis.__MF_SHARED__` so remotes can negotiate versions correctly.
- **Dynamic Manifests**: Auto-generates `mf-manifest.json` in the `assets/` folder based on your configuration for dynamic remote loading.

### 🧠 Advanced Runtime
- `loadRemoteModule()`: Failsafe dynamic remote script loading.
- **SemVer Negotiation**: Remotes negotiate versions with the Host (e.g. `^21.0.0`). If the Host provides an incompatible version (or doesn't provide it), the Remote gracefully falls back to its own copy.
- Supports `singleton: true` and `strictVersion: true`.

---

## 📦 Installation

```bash
# Add the builder to your Angular project
npm install @angular-mf/esbuild @angular-mf/core
```

---

## 🛠 Usage & Configuration

### 1. Create `mf.config.ts`
Create a Module Federation config file at the root of your Host and Remote applications.

**Remote App (`mf.config.ts`):**
```typescript
import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: 'remote',
  exposes: {
    './GreetingComponent': './projects/remote/src/app/greeting.component.ts',
  },
  shared: (defaults) => ({
    ...defaults,
  }),
});
```

**Host App (`mf.config.ts`):**
```typescript
import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: 'host',
  remotes: {
    'remote': 'http://localhost:4202/remoteEntry.js'
  },
  shared: (defaults) => ({
    ...defaults,
  }),
});
```

### 2. Update `angular.json`
Update your project targets to use the `@angular-mf/esbuild` builders.

```json
"architect": {
  "build": {
    "builder": "@angular-mf/esbuild:application",
    "options": {
      "mfConfig": "projects/host/mf.config.ts",
      "outputPath": "dist/host",
      "browser": "projects/host/src/main.ts",
      // ... standard angular build options
    }
  },
  "serve": {
    "builder": "@angular-mf/esbuild:dev-server",
    "options": {
      "buildTarget": "host:build"
    }
  }
}
```

### 3. Load Remotes Dynamically
In your host application, initialize federation and load your remote components.

**`main.ts`**
```typescript
import { initFederation } from '@angular-mf/core/runtime';

initFederation({
  remote: { remoteEntry: 'http://localhost:4202/remoteEntry.js' }
}).then(() => {
  import('./bootstrap');
});
```

**`app.routes.ts`**
```typescript
import { Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-mf/core/runtime';

export const routes: Routes = [
  {
    path: 'remote',
    loadComponent: () =>
      loadRemoteModule({
        remoteName: 'remote',
        exposedModule: './GreetingComponent',
      }).then((m) => m.Greeting),
  },
];
```

---

## 🏗 Developing locally

To build the framework from source:
```bash
npm run build -w @angular-mf/core
npm run build -w @angular-mf/esbuild
```

Test the demo applications:
```bash
# Terminal 1 - Run Remote
cd demo-app && npx ng serve remote --port 4202

# Terminal 2 - Run Host
cd demo-app && npx ng serve host --port 4200
```

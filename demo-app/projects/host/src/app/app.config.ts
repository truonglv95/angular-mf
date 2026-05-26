import { ApplicationConfig } from '@angular/core';
import { provideRouter, Routes } from '@angular/router';
import { loadRemoteModule } from '@angular-mf/core/runtime';

export const routes: Routes = [
  {
    path: 'feature',
    loadChildren: () => loadRemoteModule({
      remoteName: 'remote',
      exposedModule: './Routes'
    }).then((m: any) => m.remoteRoutes)
  }
];

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};

import { Routes } from '@angular/router';
import { FeatureComponent } from './feature/feature.component';

export const remoteRoutes: Routes = [
  { path: '', component: FeatureComponent },
  { path: 'more', loadComponent: () => import('./feature/feature.component').then(m => m.FeatureComponent) }
];

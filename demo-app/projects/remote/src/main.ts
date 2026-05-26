import { initFederation } from '@angular-mf/core/runtime';

initFederation({}).then(() => {
  import('./bootstrap').catch(err => console.error(err));
});

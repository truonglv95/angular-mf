import { initFederation } from '@angular-mf/core/runtime';

initFederation({
  'remote': { remoteEntry: 'http://localhost:4202/remoteEntry.js' }
}).then(() => {
  import('./bootstrap').catch(err => console.error(err));
});

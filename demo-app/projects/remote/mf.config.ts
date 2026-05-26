import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: 'remote',
  exposes: {
    './GreetingComponent': './projects/remote/src/app/greeting/greeting.ts',
    './Routes': './projects/remote/src/app/remote.routes.ts',
  },
  shared: (defaults) => ({
    ...defaults,
    "@angular/common/http": { singleton: true },
  }),
});

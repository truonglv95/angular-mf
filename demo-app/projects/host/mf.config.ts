import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: 'host',
  exposes: {
    // './Component': './src/app/app.component.ts',
  },
  shared: (defaults) => ({
    ...defaults,
  }),
});

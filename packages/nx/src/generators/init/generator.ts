import {
  Tree,
  formatFiles,
  readProjectConfiguration,
  updateProjectConfiguration,
  generateFiles
} from '@nx/devkit';
import { join } from 'node:path';

export interface InitGeneratorSchema {
  project: string;
}

export default async function (tree: Tree, options: InitGeneratorSchema) {
  const project = readProjectConfiguration(tree, options.project);
  
  if (!project) {
    throw new Error(`Project ${options.project} not found`);
  }

  // Update project configuration to use our executors
  if (project.targets?.build) {
    project.targets.build.executor = '@angular-mf/nx:application';
    if (!project.targets.build.options) {
      project.targets.build.options = {};
    }
    project.targets.build.options.mfConfig = `mf.config.ts`;
  }

  if (project.targets?.serve) {
    project.targets.serve.executor = '@angular-mf/nx:dev-server';
  }

  updateProjectConfiguration(tree, options.project, project);

  // Generate mf.config.ts in the project root
  const mfConfigContent = `import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: '${options.project}',
  exposes: {
    // './Component': './src/app/app.component.ts',
  },
  shared: (defaults) => ({
    ...defaults,
  }),
});
`;

  const configPath = join(project.root, 'mf.config.ts');
  if (!tree.exists(configPath)) {
    tree.write(configPath, mfConfigContent);
  }

  await formatFiles(tree);
}

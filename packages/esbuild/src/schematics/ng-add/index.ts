import type { Rule, SchematicContext, Tree } from '@angular-devkit/schematics';

interface NgAddOptions {
  project?: string;
  port?: number;
}

export function ngAdd(options: NgAddOptions): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const workspaceConfigBuffer = tree.read('angular.json');
    if (!workspaceConfigBuffer) {
      context.logger.error('Not an Angular CLI workspace (angular.json not found).');
      return tree;
    }

    const workspaceConfig = JSON.parse(workspaceConfigBuffer.toString());
    const projects = Object.keys(workspaceConfig.projects || {});
    
    if (projects.length === 0) {
      context.logger.error('Could not find any project in angular.json');
      return tree;
    }

    const projectName = options.project || workspaceConfig.defaultProject || projects[0];
    const project = workspaceConfig.projects[projectName];
    
    if (!project) {
      context.logger.error(`Project "${projectName}" not found.`);
      return tree;
    }

    // Project root could be an empty string for the root app in some workspaces
    const projectRoot = project.root ? `${project.root}/` : '';
    const configPath = `${projectRoot}mf.config.ts`;

    // Update builders
    if (project.architect?.build) {
      project.architect.build.builder = '@angular-mf/esbuild:application';
      project.architect.build.options = project.architect.build.options || {};
      project.architect.build.options.mfConfig = configPath;
    }
    
    if (project.architect?.serve) {
      project.architect.serve.builder = '@angular-mf/esbuild:dev-server';
      project.architect.serve.options = project.architect.serve.options || {};
      project.architect.serve.options.mfConfig = configPath;
      if (options.port) {
        project.architect.serve.options.port = options.port;
      }
    }

    tree.overwrite('angular.json', JSON.stringify(workspaceConfig, null, 2));

    // Generate mf.config.ts
    
    if (!tree.exists(configPath)) {
      const configContent = `import { withModuleFederation } from '@angular-mf/esbuild/config';

export default withModuleFederation({
  name: '${projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}',
  exposes: {
    // './Component': './src/app/app.component.ts',
  },
  shared: (defaults) => ({
    ...defaults,
  }),
});
`;
      tree.create(configPath, configContent);
    }

    context.logger.info(`✅ Successfully added @angular-mf/esbuild to project ${projectName}`);
    
    return tree;
  };
}

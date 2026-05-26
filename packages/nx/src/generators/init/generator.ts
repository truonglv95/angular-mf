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
  type?: 'host' | 'remote';
  remotes?: string[];
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
  const isHost = options.type !== 'remote';
  let mfConfigContent = `import { withModuleFederation } from '@angular-mf/core/config';

export default withModuleFederation({
  name: '${options.project}',
`;

  if (isHost) {
    const remotesObject = options.remotes && options.remotes.length > 0 
      ? options.remotes.map(r => `    '${r}': 'http://localhost:4200/remoteEntry.js'`).join(',\n')
      : `    // 'remoteApp': 'http://localhost:4200/remoteEntry.js'`;

    mfConfigContent += `  remotes: {\n${remotesObject}\n  },\n`;
  } else {
    mfConfigContent += `  exposes: {\n    // './Component': './src/app/app.component.ts',\n  },\n`;
  }

  mfConfigContent += `  shared: (defaults) => ({
    ...defaults,
  }),
});
`;

  const configPath = join(project.root, 'mf.config.ts');
  if (!tree.exists(configPath)) {
    tree.write(configPath, mfConfigContent);
  }

  // If host, modify main.ts to include initFederation
  if (isHost && project.sourceRoot) {
    const mainTsPath = join(project.sourceRoot, 'main.ts');
    if (tree.exists(mainTsPath)) {
      let mainContent = tree.read(mainTsPath, 'utf-8');
      if (mainContent && !mainContent.includes('initFederation')) {
        // Move bootstrap into initFederation
        const lines = mainContent.split('\n');
        const imports = lines.filter(l => l.startsWith('import'));
        const rest = lines.filter(l => !l.startsWith('import'));
        
        let newMain = `import { initFederation } from '@angular-mf/core/runtime';\n` + imports.join('\n') + '\n\n';
        newMain += `initFederation({\n`;
        if (options.remotes && options.remotes.length > 0) {
          options.remotes.forEach(r => {
            newMain += `  remote: { remoteEntry: 'http://localhost:4200/remoteEntry.js' }, // Update URL for ${r}\n`;
          });
        }
        newMain += `}).then(() => {\n`;
        newMain += rest.join('\n').replace(/^/gm, '  '); // indent
        newMain += `\n}).catch(err => console.error(err));\n`;
        
        tree.write(mainTsPath, newMain);
      }
    }
  }

  await formatFiles(tree);
}

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** LSP4IJ splits command arguments itself. No shell or installer is involved. */
export function jetbrainsTemplate({ runtime, server, config }) {
  const quote = (value) => {
    if (!path.isAbsolute(value) || /["\r\n\0]/u.test(value))
      throw new Error('Select absolute runtime, server and trusted configuration paths.');
    return `"${value.replaceAll('\\', '/')}"`;
  };
  const command = `${quote(runtime)} ${quote(server)} --config ${quote(config)}`;
  return {
    id: 'backstage-validation-engine',
    name: 'Backstage Validation Engine',
    programArgs: { default: command, windows: command },
    fileTypeMappings: [
      { fileType: { name: 'YAML', patterns: ['*.yaml', '*.yml'] }, languageId: 'yaml' },
      { fileType: { name: 'JSON', patterns: ['*.json'] }, languageId: 'json' },
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [config, destination, runtime = process.execPath] = process.argv.slice(2);
  if (!config || !destination)
    throw new Error('Expected <trusted-config.json> <template-directory> [node-executable].');
  const server = fileURLToPath(new URL('../dist/lsp/stdio.js', import.meta.url));
  await Promise.all([access(config), access(server), access(runtime)]);
  const template = jetbrainsTemplate({
    runtime: path.resolve(runtime),
    server,
    config: path.resolve(config),
  });
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, 'template.json'),
    JSON.stringify(template, null, 2) + '\n',
  );
  await writeFile(
    path.join(destination, 'README.md'),
    '# Backstage Validation Engine\n\n' +
      'Install LSP4IJ in your JetBrains editor. In Language Servers, add a server and select Import from custom template. Select this directory. Enable the server only in the project covered by the trusted configuration.\n\n' +
      'The server supplies diagnostics, field and value completion, hover, local definitions and versioned fixes when the client supports them. Credentials remain in the host environment or the configured credential file.\n\n' +
      'This template does not install packages or run a shell. Reimport it if you move the runtime, server or trusted configuration. The server watches its trusted configuration and credential file and reloads them without a restart. The search picker and persistent selection history are VS Code features.\n\n' +
      'Template format: https://github.com/redhat-developer/lsp4ij/blob/main/docs/UserDefinedLanguageServerTemplate.md\n',
  );
  process.stdout.write(path.resolve(destination) + '\n');
}

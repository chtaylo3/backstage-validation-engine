import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const domain = new Set([
  'contracts',
  'core',
  'parsing',
  'policy',
  'providers',
  'compatibility',
  'runtime',
]);
const temporary = new Set(['src/index.ts -> src/cli/sarif.ts']);
const normalize = (value) => value.replaceAll('\\', '/');
function category(file) {
  if (file.startsWith('extensions/vscode/src/')) return 'client';
  if (file === 'src/index.ts') return 'public';
  const segment = file.split('/')[1];
  return domain.has(segment) ? 'domain' : segment;
}
function forbidden(origin, target) {
  const from = category(origin);
  const to = category(target);
  if (from === 'domain' || from === 'host' || from === 'reporting')
    return ['cli', 'lsp', 'client', 'host'].includes(to) && !(from === 'host' && to === 'host');
  if (from === 'cli') return to === 'lsp' || to === 'client';
  if (from === 'lsp') return to === 'cli' || to === 'client';
  if (from === 'client') return target.startsWith('src/');
  if (from === 'public') return ['cli', 'lsp', 'client', 'host'].includes(to);
  return false;
}
function dependencies(source) {
  const result = [];
  const loaders = new Set(['require']);
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'createRequire'
    )
      loaders.add(node.name.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      result.push(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && loaders.has(node.expression.text))) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
export async function checkArchitecture(root, exceptions = temporary) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name)) files.push(filename);
    }
  }
  await walk(path.join(root, 'src'));
  await walk(path.join(root, 'extensions/vscode/src'));
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, root).options;
  const graph = new Map();
  const externals = new Map();
  for (const filename of files) {
    const relative = normalize(path.relative(root, filename));
    const source = ts.createSourceFile(
      filename,
      await readFile(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges = [];
    const packages = [];
    for (const specifier of dependencies(source)) {
      const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport)
        edges.push(normalize(path.relative(root, resolved.resolvedFileName)));
      else packages.push(specifier);
    }
    graph.set(relative, edges);
    externals.set(relative, packages);
  }
  const failures = new Set();
  for (const origin of graph.keys()) {
    const visited = new Set();
    function visit(file, chain) {
      if (visited.has(file)) return;
      visited.add(file);
      for (const pkg of externals.get(file) ?? []) {
        if (
          ['domain', 'host', 'reporting', 'cli', 'public'].includes(category(origin)) &&
          /^(?:vscode|vscode-languageserver|vscode-languageclient|vscode-jsonrpc)(?:$|[/-])/u.test(
            pkg,
          )
        )
          failures.add(`${origin} -> ${pkg} via ${[...chain, file].join(' -> ')}`);
        if (
          category(origin) === 'client' &&
          pkg.startsWith('@chtaylo3/backstage-validation-engine')
        )
          failures.add(`${origin} -> ${pkg}`);
      }
      for (const target of graph.get(file) ?? []) {
        if (forbidden(origin, target) && !exceptions.has(`${origin} -> ${target}`))
          failures.add(`${origin} -> ${target} via ${[...chain, file].join(' -> ')}`);
        visit(target, [...chain, file]);
      }
    }
    visit(origin, []);
  }
  return [...failures].sort();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? '.');
  const failures = await checkArchitecture(
    root,
    process.argv.includes('--no-exceptions') ? new Set() : temporary,
  );
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('Architectural import boundaries pass.');
}

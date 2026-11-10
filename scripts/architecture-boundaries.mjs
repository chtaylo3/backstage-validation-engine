import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const domain = new Set([
  'contracts',
  'capabilities',
  'core',
  'parsing',
  'policy',
  'providers',
  'compatibility',
  'runtime',
]);
const ownership = new Set([
  'src/lsp/workspace-state.ts',
  'src/lsp/validation-coordinator.ts',
  'src/lsp/validation-run.ts',
  'src/lsp/request-context.ts',
  'src/lsp/session-resources.ts',
  'src/lsp/catalog-refresh.ts',
  'src/lsp/diagnostic-publisher.ts',
  'src/lsp/diagnostics.ts',
  'src/lsp/client-edits.ts',
  'src/lsp/config-watches.ts',
  'src/host/catalog-config.ts',
  'src/host/builtin-validation.ts',
  'src/host/rule-contributions.ts',
  'src/capabilities/editor-artifacts.ts',
  'src/capabilities/session.ts',
  'src/capabilities/bindings.ts',
  'src/capabilities/builtin-metadata.ts',
  'src/compatibility/schema-artifacts.ts',
  'src/reporting/sarif.ts',
]);
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
  const factories = new Set(['createRequire']);
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['node:module', 'module'].includes(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements)
        if ((binding.propertyName ?? binding.name).text === 'createRequire')
          factories.add(binding.name.text);
  }
  const factory = (expression) =>
    (ts.isIdentifier(expression) && factories.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      expression.name.text === 'createRequire');
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      factory(node.initializer.expression)
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
export async function checkArchitecture(root) {
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
        if (target === origin && ownership.has(origin))
          failures.add(`Ownership dependency cycle: ${[...chain, file, target].join(' -> ')}`);
        if (forbidden(origin, target))
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
  const failures = await checkArchitecture(root);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('Architectural import boundaries pass.');
}

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Engine layers, lowest first. A file's layer is its top-level directory under `src/`. A file may
 * import its own layer and any lower layer. Layers that share an entry are peers and may not import
 * each other. `docs/architecture.md` lists the same layers in the same order.
 */
export const LAYERS = Object.freeze(
  [
    ['base'],
    ['contracts'],
    ['core'],
    ['runtime'],
    ['parsing'],
    ['compatibility'],
    ['policy'],
    ['providers'],
    ['capabilities'],
    ['pipeline'],
    ['reporting'],
    ['host'],
    ['cli', 'lsp'],
  ].map((names) => Object.freeze(names)),
);
/** Packages that only the named layers may import directly. */
export const PACKAGE_LAYERS = Object.freeze({
  '@backstage/catalog-model': Object.freeze(['compatibility']),
  'backstage-catalog-model-older': Object.freeze(['compatibility']),
  '@marcbachmann/cel-js': Object.freeze(['runtime']),
  yaml: Object.freeze(['parsing', 'lsp']),
});
/**
 * `src/index.ts` sits just above this layer: it may import this layer and every lower one. No other
 * file under `src/` may import it, directly or transitively.
 */
const PUBLIC_CEILING = 'reporting';
const VSCODE_PACKAGES =
  /^(?:vscode|vscode-languageserver|vscode-languageclient|vscode-jsonrpc)(?:$|[/-])/u;
const ranks = new Map(LAYERS.flatMap((names, rank) => names.map((name) => [name, rank])));
const normalize = (value) => value.replaceAll('\\', '/');
function category(file) {
  if (file.startsWith('extensions/vscode/src/')) return 'client';
  if (file === 'src/index.ts') return 'public';
  const parts = file.split('/');
  if (parts[0] !== 'src') return 'external';
  return parts.length > 2 && ranks.has(parts[1]) ? parts[1] : 'unlisted';
}
function rank(name) {
  return name === 'public' ? ranks.get(PUBLIC_CEILING) + 0.5 : ranks.get(name);
}
/** Returns why an import from `origin` to `target` is forbidden, or undefined when it is allowed. */
function forbidden(origin, target) {
  const from = category(origin);
  const to = category(target);
  if (from === 'client') return target.startsWith('src/') ? 'client imports src/' : undefined;
  if (to === 'client') return 'imports the VS Code client';
  if (to === 'public' && from !== 'public') return 'imports the public barrel src/index.ts';
  if (from === 'unlisted' || to === 'unlisted' || to === 'external') return undefined;
  if (from === to) return undefined;
  if (rank(to) === rank(from)) return `peer layers ${from} and ${to} may not import each other`;
  if (rank(to) > rank(from)) return `upward import from ${from} to ${to}`;
  return undefined;
}
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
/** One readable chain per strongly connected component of the file graph. */
function cycles(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let counter = 0;
  function connect(file) {
    index.set(file, counter);
    low.set(file, counter++);
    stack.push(file);
    onStack.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!graph.has(target)) continue;
      if (!index.has(target)) {
        connect(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (onStack.has(target)) low.set(file, Math.min(low.get(file), index.get(target)));
    }
    if (low.get(file) !== index.get(file)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > 1 || (graph.get(file) ?? []).includes(file))
      components.push(new Set(component));
  }
  for (const file of [...graph.keys()].sort()) if (!index.has(file)) connect(file);
  return components.map((component) => {
    const start = [...component].sort()[0];
    const previous = new Map([[start, undefined]]);
    const queue = [start];
    while (queue.length) {
      const file = queue.shift();
      for (const target of [...(graph.get(file) ?? [])].sort()) {
        if (target === start) {
          const chain = [start];
          for (let step = file; step !== start; step = previous.get(step)) chain.splice(1, 0, step);
          return [...chain, start];
        }
        if (component.has(target) && !previous.has(target)) {
          previous.set(target, file);
          queue.push(target);
        }
      }
    }
    return [start, start];
  });
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
  for (const file of graph.keys()) {
    if (category(file) === 'unlisted')
      failures.add(
        `${file} is not in a layer: top-level src/ directories must be one of ${LAYERS.flat().join(', ')}`,
      );
    for (const pkg of externals.get(file) ?? []) {
      const allowed = PACKAGE_LAYERS[packageName(pkg)];
      if (allowed && file.startsWith('src/') && !allowed.includes(category(file)))
        failures.add(`${file} -> ${pkg}: package may only be imported from ${allowed.join(', ')}`);
    }
  }
  for (const origin of graph.keys()) {
    const visited = new Set();
    function visit(file, chain) {
      if (visited.has(file)) return;
      visited.add(file);
      for (const pkg of externals.get(file) ?? []) {
        if (!['lsp', 'client'].includes(category(origin)) && VSCODE_PACKAGES.test(pkg))
          failures.add(`${origin} -> ${pkg} via ${[...chain, file].join(' -> ')}`);
        if (
          category(origin) === 'client' &&
          pkg.startsWith('@chtaylo3/backstage-validation-engine')
        )
          failures.add(`${origin} -> ${pkg}`);
      }
      for (const target of graph.get(file) ?? []) {
        const reason = forbidden(origin, target);
        if (reason)
          failures.add(
            `${origin} -> ${target} (${reason}) via ${[...chain, file, target].join(' -> ')}`,
          );
        visit(target, [...chain, file]);
      }
    }
    visit(origin, []);
  }
  const sources = new Map([...graph].filter(([file]) => file.startsWith('src/')));
  for (const chain of cycles(sources)) failures.add(`Import cycle: ${chain.join(' -> ')}`);
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

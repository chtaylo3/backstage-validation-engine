import { createSourceSnapshot, locateParsedPath, parseSourceSnapshot } from '../dist/index.js';

const source = createSourceSnapshot({
  repository: 'https://github.com/example/application',
  revision: 'synthetic-parsing-example',
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      origin: 'buffer',
      version: 7,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: example\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/platform\n',
    },
  ],
});

const report = await parseSourceSnapshot(source, { mode: 'ide', deadlineAt: Date.now() + 5000 });
console.log(
  JSON.stringify(
    {
      sourceDigest: report.sourceDigest,
      documents: report.documents.map((document) => ({
        uri: document.uri,
        document: document.document,
        version: document.version,
        value: document.value,
        nameLocation: locateParsedPath(document, '/metadata/name'),
      })),
      diagnostics: report.diagnostics,
      coverage: report.coverage,
      interrupted: report.interrupted,
    },
    null,
    2,
  ),
);

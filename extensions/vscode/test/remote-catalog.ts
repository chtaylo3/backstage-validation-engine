import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEditorCatalog } from './catalog-fixture.js';
async function main(): Promise<void> {
  const [root, session] = process.argv.slice(2);
  if (!root || !session || !process.env.BVE_EDITOR_CATALOG_TOKEN)
    throw new Error('Remote catalog needs explicit fixture credentials.');
  const fixture = await createEditorCatalog(root, process.env.BVE_EDITOR_CATALOG_TOKEN);
  await writeFile(
    path.join(session, 'catalog.json'),
    JSON.stringify({
      pid: process.pid,
      controlUrl: fixture.controlUrl,
      controlToken: fixture.controlToken,
      catalogs: fixture.catalogs,
    }),
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void fixture
      .close()
      .then(() =>
        writeFile(
          path.join(session, 'catalog-events.json'),
          JSON.stringify(fixture.evidence(), null, 2) + '\n',
        ),
      )
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

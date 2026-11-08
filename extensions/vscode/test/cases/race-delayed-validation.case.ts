import assert from 'node:assert/strict';
import type { Fixture } from '../fixture.js';
export async function run(fixture: Fixture): Promise<void> {
  const document = await fixture.document();
  const text = document.getText();
  for (let version = 0; version < fixture.catalogs().length; version++) {
    await fixture.useCatalog(version);
    await fixture.currentDiagnostic(document);
    const gate = await fixture.control({
      op: 'arm',
      version,
      operation: 'byName',
      entityRef: 'group:default/missing',
    });
    try {
      await fixture.replace(document, text.replace('owner: team', 'owner: missing'));
      await fixture.control({ op: 'entered', id: gate.id });
      await fixture.replace(document, text + `# newer version ${version}\n`);
      await fixture.control({ op: 'cancelled', id: gate.id });
      await fixture.currentDiagnostic(document);
      await fixture.control({ op: 'release', id: gate.id });
      await fixture.fix();
      assert.equal(fixture.has('owner-exists'), false);
      assert.equal(document.getText(), text + `# newer version ${version}\n`);
    } finally {
      await fixture.control({ op: 'release', id: gate.id });
    }
  }
}

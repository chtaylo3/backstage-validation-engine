import { readFile } from 'node:fs/promises';
import Draft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';

export async function sarifValidator() {
  const schema = JSON.parse(
    await readFile('test/fixtures/conformance/sarif-schema-2.1.0.json', 'utf8'),
  ) as object;
  // OASIS draft-04 bytes remain unchanged. The schema contains a legacy non-Unicode regex.
  const ajv = new Draft04.default({ strict: false, unicodeRegExp: false, allErrors: true });
  addFormats.default(ajv, { mode: 'full' });
  return ajv.compile(schema);
}

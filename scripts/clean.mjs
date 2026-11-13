import { rm } from 'node:fs/promises';

const outputs = {
  all: ['dist', '.test-dist', 'coverage'],
  build: ['dist'],
  tests: ['.test-dist'],
};
const mode = process.argv[2] ?? 'all';
if (!Object.hasOwn(outputs, mode)) throw new Error(`Unknown clean mode: ${mode}`);
for (const directory of outputs[/** @type {keyof typeof outputs} */ (mode)]) {
  await rm(new URL(`../${directory}`, import.meta.url), { recursive: true, force: true });
}

import { fileURLToPath } from 'node:url';
import { packageCliCandidate } from './cli-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { archive, metadata } = await packageCliCandidate(root);
console.log(`CLI archive: ${archive}`);
console.log(
  `Revision: ${metadata.revision}; SHA-256: ${metadata.sha256}; dirty: ${metadata.sourceDirty}`,
);

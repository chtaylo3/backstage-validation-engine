import { parentPort } from 'node:worker_threads';
import { CEL_PROFILE } from '../../src/runtime/cel/limits.js';

if (!parentPort) throw new Error('Test worker requires a parent');
const port = parentPort;
port.on('message', (request: { id: number; expression: string; entity: unknown }) => {
  if (request.expression === 'hang') {
    while (true) {
      /* Fault injection: parent must terminate this worker. */
    }
  }
  if (request.expression === 'crash') process.exit(1);
  if (request.expression === 'wrong-id') {
    port.postMessage({ type: 'result', id: request.id + 1, ok: true, value: true });
    return;
  }
  if (request.expression === 'malformed') {
    port.postMessage({ value: true });
    return;
  }
  if (request.expression === 'throw') throw new Error('SENSITIVE TEST WORKER ERROR');
  const delay = request.expression.startsWith('delay:') ? Number(request.expression.slice(6)) : 0;
  setTimeout(() => {
    port.postMessage({
      type: 'result',
      id: request.id,
      ok: true,
      value: request.expression === 'env-empty' ? Object.keys(process.env).length === 0 : true,
    });
  }, delay);
});
port.postMessage({ type: 'ready', version: 1, profile: CEL_PROFILE });

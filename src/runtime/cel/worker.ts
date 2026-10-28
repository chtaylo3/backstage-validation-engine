import { parentPort } from 'node:worker_threads';
import { createCelEvaluator } from './evaluator.js';
import { CelError } from './errors.js';
import { CEL_PROFILE } from './limits.js';
import type { CelWorkerReply, CelWorkerRequest } from './protocol.js';

if (!parentPort) throw new Error('CEL worker requires a parent');
const port = parentPort;
const evaluate = createCelEvaluator();
port.on('message', (request: CelWorkerRequest) => {
  let reply: CelWorkerReply;
  try {
    reply = {
      type: 'result',
      id: request.id,
      ok: true,
      value: evaluate(request.expression, request.entity),
    };
  } catch (error) {
    reply = {
      type: 'result',
      id: request.id,
      ok: false,
      code: error instanceof CelError ? error.code : 'worker_failure',
    };
  }
  port.postMessage(reply);
});
port.postMessage({ type: 'ready', version: 1, profile: CEL_PROFILE });

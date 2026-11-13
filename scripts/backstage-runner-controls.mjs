#!/usr/bin/env node
import assert from 'node:assert/strict';
import { executeHostControl } from '../test/integration/backstage/lib/host-controls.mjs';
const [fault, directory] = process.argv.slice(2);
assert(directory, 'Supply an isolated scratch evidence directory.');
const result = await executeHostControl(directory, fault);
console.log(JSON.stringify({ status: result.report.status, exitCode: result.exitCode }));
process.exitCode = result.exitCode;

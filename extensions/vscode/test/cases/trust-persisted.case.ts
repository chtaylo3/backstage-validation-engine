import { trustScenario } from '../trust.js';
import type { Fixture } from '../fixture.js';
export const initialRunning = false;
export const activate = false;
export const run = (fixture: Fixture) => trustScenario(fixture, 'persisted');

import { endurance } from '../endurance.js';
import type { Fixture } from '../fixture.js';
export const activate = false;
export const run = (fixture: Fixture): Promise<void> => endurance(fixture);

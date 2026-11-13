import { createBackend } from '@backstage/backend-defaults';
import { testPermissions } from './test-permissions.mjs';
const backend = createBackend();
backend.add(testPermissions);
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
await backend.start();

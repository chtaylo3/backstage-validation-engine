import { createApp } from '@backstage/frontend-defaults';
import authPlugin from '@backstage/plugin-auth';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
export default createApp({ features: [catalogPlugin, authPlugin] });

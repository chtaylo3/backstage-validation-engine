import { coreServices, createServiceFactory } from '@backstage/backend-plugin-api';
import { ServerPermissionClient } from '@backstage/plugin-permission-node';

// Test-only policy. Native service-token access restrictions always run first.
export const testPermissions = createServiceFactory({
  service: coreServices.permissions,
  deps: {
    auth: coreServices.auth,
    config: coreServices.rootConfig,
    discovery: coreServices.discovery,
  },
  async factory({ auth, config, discovery }) {
    const native = ServerPermissionClient.fromConfig(config, { auth, discovery });
    const decide = async (method, requests, options) => {
      const decisions = await native[method](requests, options);
      const service = Boolean(
        options?.credentials && auth.isPrincipal(options.credentials, 'service'),
      );
      const subject = service ? options.credentials.principal.subject : undefined;
      return decisions.map((decision, index) => {
        const permission = requests[index].permission.name;
        const result =
          decision.result === 'ALLOW' &&
          subject === 'bve-filtered' &&
          permission === 'catalog.entity.read'
            ? 'DENY'
            : decision.result;
        if (service && ['bve-filtered', 'bve-reader', 'bve-administrator'].includes(subject)) {
          console.log(
            'H4_PERMISSION_DECISION ' +
              JSON.stringify({
                subject,
                permission,
                nativeResult: decision.result,
                result,
                method,
              }),
          );
        }
        return result === decision.result ? decision : { ...decision, result };
      });
    };
    return {
      authorize: (requests, options) => decide('authorize', requests, options),
      authorizeConditional: (requests, options) =>
        decide('authorizeConditional', requests, options),
    };
  },
});

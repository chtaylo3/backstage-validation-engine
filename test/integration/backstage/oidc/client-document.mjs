#!/usr/bin/env node
// Serves OAuth client ID metadata documents over HTTPS on the Compose network, so that a real
// Backstage application can fetch them. The certificate comes from the host runner, and Backstage
// trusts its authority through NODE_EXTRA_CA_CERTS. The documents hold no secret.
//
// Usage: node client-document.mjs --directory=/oidc --origin=https://client-document:8443
// Fetches are recorded and served at GET /_observations for the flow script.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';

export const VSCODE_REDIRECT_URI = 'vscode://chtaylo3.backstage-validation-engine/sign-in';

/** The client documents that the harness serves, by path. */
export function clientDocuments(origin) {
  const document = (name, redirectUris) => ({
    client_id: `${origin}/${name}`,
    client_name: 'Backstage Validation Engine for VS Code',
    redirect_uris: redirectUris,
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    scope: 'openid offline_access',
  });
  return {
    // The document that the test configuration allows: the one redirect URI of the extension.
    '/vscode-client.json': document('vscode-client.json', [VSCODE_REDIRECT_URI]),
    // A well-formed document whose URL the configuration does not allow.
    '/unlisted-client.json': document('unlisted-client.json', [VSCODE_REDIRECT_URI]),
  };
}

function option(name) {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  assert(value, `Supply --${name}.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = option('directory');
  const origin = option('origin');
  const port = Number(new URL(origin).port);
  const documents = clientDocuments(origin);
  const fetches = [];
  const server = createServer(
    {
      key: readFileSync(path.join(directory, 'client-document.key')),
      cert: readFileSync(path.join(directory, 'client-document.pem')),
    },
    (request, response) => {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/_observations') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ fetches }));
        return;
      }
      const row = {
        at: new Date().toISOString(),
        path: url.pathname,
        accept: request.headers.accept ?? null,
        status: documents[url.pathname] ? 200 : 404,
      };
      fetches.push(row);
      console.log('client-document fetch ' + JSON.stringify(row));
      if (!documents[url.pathname]) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(documents[url.pathname]));
    },
  );
  server.listen(port, '0.0.0.0', () => console.log(`client-document listening on ${origin}`));
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

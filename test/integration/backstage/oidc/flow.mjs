#!/usr/bin/env node
// Performs the sign-in flow of the VS Code extension against a real Backstage application, without
// VS Code: discovery, the authorization request with PKCE S256, guest sign-in and consent in a real
// browser, the code exchange, userinfo, catalog reads, refresh, and revocation. It runs in the test
// container of the Compose environment; `run.mjs` starts it.
//
// Nothing that Backstage issues is printed or written: tokens, codes, and verifiers stay in memory.
// The report holds statuses, error bodies, lengths, claim names, and URLs with secret values
// redacted. The script fails if any issued value appears in its report.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URLSearchParams } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import {
  chromiumExecutable,
  clickButton,
  evaluate,
  launchBrowser,
  waitFor,
} from '../editor/cdp.mjs';
import { VSCODE_REDIRECT_URI } from './client-document.mjs';

const options = Object.fromEntries(
  process.argv
    .slice(2)
    .map((item) => /^--([a-z-]+)=(.*)$/u.exec(item))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
for (const name of ['public-url', 'backend', 'client-origin', 'out', 'release', 'second-user'])
  assert(options[name], `Supply --${name}.`);
const publicUrl = new URL(options['public-url']);
const backend = new URL(options.backend);
const clientOrigin = options['client-origin'];
const clientId = `${clientOrigin}/vscode-client.json`;
const unlistedClientId = `${clientOrigin}/unlisted-client.json`;
const expectedLifetime = Number(options['expected-lifetime'] ?? 3600);
const out = options.out;
const control = path.join(out, 'control');
const entityPath = '/api/catalog/entities/by-name/component/bve-demo/demo-service';

// ---------- secrets stay in memory ----------
const secrets = new Set();
const keep = (value) => {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
  return value;
};
const redactUrl = (value) => {
  if (!value) return value;
  try {
    const url = new URL(value);
    for (const key of ['code', 'state', 'code_challenge'])
      if (url.searchParams.has(key))
        url.searchParams.set(key, `<redacted length=${url.searchParams.get(key).length}>`);
    return url.toString();
  } catch {
    return '<unparsable URL>';
  }
};
const claims = (token) => {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return {
      iss: value.iss,
      sub: value.sub,
      aud: value.aud,
      ent: Array.isArray(value.ent) ? value.ent : undefined,
      lifetimeSeconds: value.exp - value.iat,
      claimNames: Object.keys(value).sort(),
    };
  } catch {
    return 'not a JWT';
  }
};

// ---------- the public URL of the application, inside this container ----------
// The browser and the API share Backstage's configured public URL, as in the extension's topology.
const forwarder = net.createServer((socket) => {
  const upstream = net.connect(Number(backend.port || 80), backend.hostname);
  socket.pipe(upstream).pipe(socket);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on('error', close);
  upstream.on('error', close);
});
await new Promise((resolve, reject) => {
  forwarder.once('error', reject);
  forwarder.listen(Number(publicUrl.port), '127.0.0.1', resolve);
});
const api = (pathname) => new URL(pathname, publicUrl).toString();

async function http(url, { method = 'GET', headers = {}, form, token } = {}) {
  const response = await globalThis.fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 400);
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    location: response.headers.get('location'),
    body,
  };
}
const errorOf = (body) =>
  body && typeof body === 'object'
    ? body.error && typeof body.error === 'object'
      ? { name: body.error.name, message: body.error.message }
      : { error: body.error, error_description: body.error_description }
    : body;

function pkce() {
  const verifier = keep(randomBytes(32).toString('base64url'));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = keep(randomBytes(16).toString('base64url'));
  return { verifier, challenge, state };
}
function authorizeUrl(
  discovery,
  { client = clientId, redirectUri = VSCODE_REDIRECT_URI, attempt },
) {
  return `${discovery.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: redirectUri,
    scope: 'openid offline_access',
    state: attempt.state,
    code_challenge: attempt.challenge,
    code_challenge_method: 'S256',
  })}`;
}
async function documentFetches() {
  const response = await globalThis.fetch(`${clientOrigin}/_observations`);
  return (await response.json()).fetches;
}

// ---------- browser: guest sign-in and consent ----------
async function signInInBrowser(url) {
  const browser = await launchBrowser({ executable: await chromiumExecutable() });
  const { page } = browser;
  const navigations = [];
  const approvals = [];
  page.on((event) => {
    const target = event.params?.url ?? event.params?.request?.url;
    if (
      [
        'Page.frameRequestedNavigation',
        'Page.frameStartedNavigating',
        'Page.frameScheduledNavigation',
      ].includes(event.method) &&
      typeof target === 'string' &&
      target.startsWith('vscode:')
    )
      navigations.push({ event: event.method, url: keep(target) });
    if (
      event.method === 'Network.responseReceived' &&
      /\/v1\/sessions\/[^/]+\/approve$/u.test(event.params.response.url)
    )
      approvals.push({ requestId: event.params.requestId, status: event.params.response.status });
  });
  try {
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Page.navigate', { url });
    const first = await waitFor(
      page,
      `(() => { const t = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()); return t.includes('Authorize') ? 'consent' : t.includes('Enter') ? 'sign-in' : ''; })()`,
      'the guest sign-in page or the consent page',
    );
    const pages = [first];
    if (first === 'sign-in') {
      assert(await clickButton(page, 'Enter'), 'Click the guest sign-in button.');
      await waitFor(
        page,
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Authorize')`,
        'the consent page after guest sign-in',
      );
      pages.push('consent');
    }
    const consentText = await evaluate(page, 'document.body.innerText');
    const location = await evaluate(page, 'location.pathname');
    assert(await clickButton(page, 'Authorize'), 'Click Authorize on the consent page.');
    const until = Date.now() + 20_000;
    while (!navigations.length && Date.now() < until) await pause(100);
    let approval;
    if (approvals.length) {
      const body = await page
        .send('Network.getResponseBody', { requestId: approvals[0].requestId })
        .catch(() => undefined);
      approval = { status: approvals[0].status, redirectUrl: undefined };
      if (body?.body) {
        const value = JSON.parse(body.body);
        approval.redirectUrl = keep(value.redirectUrl);
      }
    }
    const redirect = navigations[0]?.url ?? approval?.redirectUrl;
    return {
      redirect,
      report: {
        pages,
        consentPath: location.replace(/[0-9a-f-]{36}/u, '<session>'),
        consentShowsClientName: consentText.includes('Backstage Validation Engine for VS Code'),
        consentShowsRedirectUri: consentText.includes(VSCODE_REDIRECT_URI),
        approveStatus: approval?.status,
        redirectObservedAs: navigations[0]
          ? `browser navigation (${navigations[0].event})`
          : approval?.redirectUrl
            ? 'approve response body only; the browser reported no vscode: navigation'
            : 'not observed',
        browserNavigationEvents: navigations.map((row) => row.event),
      },
    };
  } finally {
    await browser.close();
  }
}

function redirectShape(redirect, attempt) {
  const url = new URL(redirect);
  return {
    url: redactUrl(redirect),
    protocol: url.protocol,
    authority: url.host,
    pathname: url.pathname,
    queryKeys: [...url.searchParams.keys()],
    stateMatches: url.searchParams.get('state') === attempt.state,
    codeLength: url.searchParams.get('code')?.length,
  };
}

async function exchange(discovery, { code, verifier, redirectUri = VSCODE_REDIRECT_URI }) {
  const result = await http(discovery.token_endpoint, {
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    },
  });
  return describeTokens(result);
}
function describeTokens(result) {
  const body = result.body;
  if (result.status !== 200 || typeof body !== 'object' || !body.access_token)
    return { report: { status: result.status, error: errorOf(body) } };
  keep(body.access_token);
  keep(body.id_token);
  keep(body.refresh_token);
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    report: {
      status: result.status,
      fields: Object.keys(body).sort(),
      token_type: body.token_type,
      expires_in: body.expires_in,
      scope: body.scope,
      accessTokenLength: body.access_token.length,
      idTokenEqualsAccessToken:
        body.id_token === undefined ? null : body.id_token === body.access_token,
      refreshTokenPresent: typeof body.refresh_token === 'string',
      refreshTokenLength: body.refresh_token?.length,
      accessClaims: claims(body.access_token),
    },
  };
}
async function refresh(discovery, refreshToken, extra = {}) {
  return describeTokens(
    await http(discovery.token_endpoint, {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: refreshToken, ...extra },
    }),
  );
}
async function catalogRead(token) {
  const one = await http(api(entityPath), { token });
  const list = await http(api('/api/catalog/entities?filter=kind=component'), { token });
  return {
    byName: {
      status: one.status,
      entity:
        one.status === 200
          ? `component:${one.body.metadata.namespace}/${one.body.metadata.name}`
          : undefined,
      error: one.status === 200 ? undefined : errorOf(one.body),
    },
    list: {
      status: list.status,
      count: Array.isArray(list.body) ? list.body.length : undefined,
      error: Array.isArray(list.body) ? undefined : errorOf(list.body),
    },
  };
}
async function hostControl(action, variant) {
  await mkdir(control, { recursive: true });
  const id = `${action}-${variant}-${Date.now()}`;
  await writeFile(path.join(control, 'request.json'), JSON.stringify({ id, action, variant }));
  const until = Date.now() + 240_000;
  for (;;) {
    const answer = await readFile(path.join(control, 'acknowledgement.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (answer?.id === id) {
      assert.equal(answer.status, 'passed', `The host could not ${action} ${variant}.`);
      return;
    }
    assert(Date.now() < until, `The host did not answer ${action} ${variant}.`);
    await pause(250);
  }
}
async function fullSignIn(discovery) {
  const attempt = pkce();
  const before = (await documentFetches()).length;
  const browser = await signInInBrowser(authorizeUrl(discovery, { attempt }));
  const fetches = (await documentFetches()).slice(before);
  assert(browser.redirect, 'The consent page must give a redirect with a code.');
  const code = keep(new URL(browser.redirect).searchParams.get('code'));
  return { attempt, code, browser, fetches, shape: redirectShape(browser.redirect, attempt) };
}

// ---------- the flow ----------
const report = {
  release: options.release,
  startedAt: new Date().toISOString(),
  configuration: {
    publicUrl: publicUrl.origin,
    clientId,
    redirectUri: VSCODE_REDIRECT_URI,
    expectedAccessTokenLifetimeSeconds: expectedLifetime,
    secondUser: options['second-user'],
  },
  steps: {},
};
const scrub = (text) => {
  for (const value of secrets) text = text.split(value).join('<redacted>');
  return text;
};
const step = (id, value) => {
  const text = JSON.stringify(value);
  assert.equal(scrub(text), text, `The ${id} observation must not contain an issued value.`);
  report.steps[id] = value;
  console.log(`[${options.release}] ${id}: ${text}`);
};
let failure;
try {
  // Discovery.
  const wellKnown = await http(api('/api/auth/.well-known/openid-configuration'));
  assert.equal(wellKnown.status, 200);
  const discovery = wellKnown.body;
  const origins = [
    'authorization_endpoint',
    'token_endpoint',
    'userinfo_endpoint',
    'revocation_endpoint',
    'jwks_uri',
  ].map((key) => new URL(discovery[key]).origin);
  step('discovery', {
    status: wellKnown.status,
    issuer: discovery.issuer,
    issuerIsAuthPluginBase: discovery.issuer === api('/api/auth'),
    endpointsShareIssuerOrigin: origins.every((origin) => origin === publicUrl.origin),
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    userinfo_endpoint: discovery.userinfo_endpoint,
    revocation_endpoint: discovery.revocation_endpoint,
    client_id_metadata_document_supported: discovery.client_id_metadata_document_supported,
    code_challenge_methods_supported: discovery.code_challenge_methods_supported,
    token_endpoint_auth_methods_supported: discovery.token_endpoint_auth_methods_supported,
    grant_types_supported: discovery.grant_types_supported,
    scopes_supported: discovery.scopes_supported,
  });

  // B1, B3, test case 1: the whole flow with the vscode:// redirect URI.
  const first = await fullSignIn(discovery);
  step('B1-B3.authorize-consent-redirect', {
    ...first.browser.report,
    redirect: first.shape,
    clientDocumentFetches: first.fetches.map((row) => `${row.path} ${row.status}`),
  });

  // Test case 2: a wrong verifier is refused, and does not burn the code.
  const wrong = await exchange(discovery, {
    code: first.code,
    verifier: keep(randomBytes(32).toString('base64url')),
  });
  step('TC2.wrong-verifier', wrong.report);

  const issued = await exchange(discovery, { code: first.code, verifier: first.attempt.verifier });
  step('TC1.exchange', issued.report);
  assert(issued.access, 'The code exchange must issue an access token.');

  // Test case 3: a second exchange of the same code.
  const replay = await exchange(discovery, { code: first.code, verifier: first.attempt.verifier });
  step('TC3.second-exchange', replay.report);

  // B4: userinfo and the catalog as a user.
  const userinfo = await http(discovery.userinfo_endpoint, { token: issued.access });
  step('B4.userinfo', { status: userinfo.status, body: userinfo.body });
  step('B4-TC1.catalog-read', {
    withIssuedToken: await catalogRead(issued.access),
    withoutToken: (await http(api(entityPath))).status,
  });

  // B6: the reported expiry against the token's own lifetime.
  step('B6.expiry', {
    configuredLifetimeSeconds: expectedLifetime,
    expires_in: issued.report.expires_in,
    accessTokenLifetimeSeconds: issued.report.accessClaims.lifetimeSeconds,
    expiresInMatchesToken: issued.report.expires_in === issued.report.accessClaims.lifetimeSeconds,
  });

  // B2: refresh, rotation, reuse of an old refresh token, and revocation.
  assert(issued.refresh, 'offline_access must issue a refresh token.');
  const r1 = issued.refresh;
  const second = await refresh(discovery, r1);
  step('B2.refresh', {
    ...second.report,
    refreshTokenRotated: typeof second.refresh === 'string' && second.refresh !== r1,
    catalogWithRefreshedToken: second.access
      ? (await catalogRead(second.access)).byName
      : undefined,
  });
  const reuse = await refresh(discovery, r1);
  step('B2-TC6.reuse-rotated-out', reuse.report);
  const afterReuse = await refresh(discovery, second.refresh);
  step('B2-TC6.current-after-reuse', {
    ...afterReuse.report,
    refreshTokenRotated:
      typeof afterReuse.refresh === 'string' && afterReuse.refresh !== second.refresh,
  });
  // A public client sends no credentials, so Backstage does not check which client refreshes.
  const otherClient = await refresh(discovery, afterReuse.refresh, { client_id: unlistedClientId });
  step('B2.refresh-with-other-client-id', otherClient.report);
  const current = otherClient.refresh ?? afterReuse.refresh;
  const currentAccess = otherClient.access ?? afterReuse.access;
  const revokeOther = await http(discovery.revocation_endpoint, {
    method: 'POST',
    form: { token: current, client_id: 'https://client-document:8443/not-allowed.json' },
  });
  step('B2.revoke-with-unallowed-client', {
    status: revokeOther.status,
    error: errorOf(revokeOther.body),
  });
  const revoke = await http(discovery.revocation_endpoint, {
    method: 'POST',
    form: { token: current, client_id: clientId },
  });
  step('B2.revoke', { status: revoke.status, body: revoke.body });
  step('B2.refresh-after-revoke', (await refresh(discovery, current)).report);
  step('TC7.access-token-after-revoke', {
    catalog: (await catalogRead(currentAccess)).byName,
    userinfo: (await http(discovery.userinfo_endpoint, { token: currentAccess })).status,
    note: 'The access token is a signed JWT. Revocation deletes the refresh session only.',
  });

  // Test cases 4 and 5: refused authorization requests. No browser is needed: the refusal is
  // the answer of /v1/authorize itself.
  const refusal = async (id, client, redirectUri) => {
    const before = (await documentFetches()).length;
    const attempt = pkce();
    const result = await http(authorizeUrl(discovery, { client, redirectUri, attempt }));
    step(id, {
      client,
      redirectUri,
      status: result.status,
      contentType: result.contentType,
      location: redactUrl(result.location),
      error: errorOf(result.body),
      clientDocumentFetches: (await documentFetches())
        .slice(before)
        .map((row) => `${row.path} ${row.status}`),
    });
  };
  await refusal(
    'TC4.redirect-with-query-not-in-document',
    clientId,
    `${VSCODE_REDIRECT_URI}?windowId=1`,
  );
  await refusal('TC4.redirect-of-other-extension', clientId, 'vscode://other.publisher/sign-in');
  await refusal('TC4.loopback-redirect', clientId, 'http://127.0.0.1:43123/callback');
  await refusal('TC5.client-not-allowed', unlistedClientId, VSCODE_REDIRECT_URI);

  // B5: a second user, signed in while the first user's token is still valid.
  const firstUser = await fullSignIn(discovery);
  const firstTokens = await exchange(discovery, {
    code: firstUser.code,
    verifier: firstUser.attempt.verifier,
  });
  assert(firstTokens.access);
  await hostControl('variant', 'second-user');
  const secondUser = await fullSignIn(discovery);
  const secondTokens = await exchange(discovery, {
    code: secondUser.code,
    verifier: secondUser.attempt.verifier,
  });
  assert(secondTokens.access);
  step('B5.two-users', {
    firstUser: {
      sub: firstTokens.report.accessClaims.sub,
      catalog: await catalogRead(firstTokens.access),
    },
    secondUser: {
      sub: secondTokens.report.accessClaims.sub,
      userinfo: (await http(discovery.userinfo_endpoint, { token: secondTokens.access })).body,
      catalog: await catalogRead(secondTokens.access),
    },
    note: 'The application restarted with another guest identity between the two sign-ins.',
  });
} catch (error) {
  failure = error;
  report.error = scrub(String(error?.stack ?? error));
} finally {
  report.completedAt = new Date().toISOString();
  report.status = failure ? 'failed' : 'passed';
  forwarder.close();
  const text = JSON.stringify(report, null, 2) + '\n';
  const leaked = [...secrets].filter((value) => text.includes(value));
  await mkdir(out, { recursive: true });
  await rm(path.join(control, 'request.json'), { force: true });
  if (leaked.length) {
    await writeFile(
      path.join(out, `flow-${options.release}.json`),
      JSON.stringify({
        release: options.release,
        status: 'failed',
        error: 'An issued value reached the report; it was discarded.',
      }) + '\n',
    );
    console.error(
      `[${options.release}] An issued value reached the report; the report was discarded.`,
    );
    process.exitCode = 1;
  } else {
    await writeFile(path.join(out, `flow-${options.release}.json`), text);
    console.log(`[${options.release}] flow ${report.status}`);
    if (failure) {
      console.error(report.error);
      process.exitCode = 1;
    }
  }
}

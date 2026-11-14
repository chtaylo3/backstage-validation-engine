// The expected outcomes of the sign-in flow (`flow.mjs`) and of the backend log facts that the host
// runner (`run.mjs`) collects. A refusal that does not happen, a `state` that does not match, a
// missing step, or a missing policy decision fails the run. Observations that are answers (B6, test
// case 7, the refresh with another client ID) are recorded without a check.

/** A token-endpoint refusal with Backstage's `invalid_grant` and this exact description. */
const refused = (description) => (row) =>
  row?.status === 400 &&
  row?.error?.error === 'invalid_grant' &&
  row?.error?.error_description === description;
const message = (row) => String(row?.error?.message ?? '');

/** @type {Record<string, (step: any, steps: Record<string, any>, options: { secondUser: string }) => boolean>} */
const FLOW = {
  discovery: (s) =>
    s.issuerIsAuthPluginBase &&
    s.endpointsShareIssuerOrigin &&
    s.client_id_metadata_document_supported === true &&
    s.code_challenge_methods_supported?.includes('S256') &&
    s.grant_types_supported?.includes('refresh_token'),
  'B1-B3.authorize-consent-redirect': (s) =>
    s.pages?.includes('consent') &&
    String(s.redirectObservedAs).startsWith('browser navigation') &&
    s.redirect?.protocol === 'vscode:' &&
    s.redirect?.authority === 'chtaylo3.backstage-validation-engine' &&
    s.redirect?.pathname === '/sign-in' &&
    s.redirect?.stateMatches === true &&
    s.redirect?.codeLength > 0 &&
    s.clientDocumentFetches?.length > 0,
  'TC2.wrong-verifier': refused('Invalid code verifier'),
  'TC1.exchange': (s) =>
    s.status === 200 && s.refreshTokenPresent === true && /^user:/u.test(s.accessClaims?.sub),
  'TC3.second-exchange': refused('Authorization code already used'),
  'B4.userinfo': (s, steps) =>
    s.status === 200 && s.body?.claims?.sub === steps['TC1.exchange']?.accessClaims?.sub,
  'B4-TC1.catalog-read': (s) =>
    s.withIssuedToken?.byName?.status === 200 &&
    s.withIssuedToken?.byName?.entity === 'component:bve-demo/demo-service' &&
    s.withoutToken === 401,
  'B2.refresh': (s) =>
    s.status === 200 &&
    s.refreshTokenRotated === true &&
    s.catalogWithRefreshedToken?.status === 200,
  'B2-TC6.reuse-rotated-out': refused('Invalid refresh token'),
  'B2-TC6.current-after-reuse': (s) => s.status === 200 && s.refreshTokenRotated === true,
  'B2.revoke-with-unallowed-client': (s) => s.status === 401 && s.error?.error === 'invalid_client',
  'B2.revoke': (s) => s.status === 200,
  'B2.refresh-after-revoke': refused('Invalid refresh token'),
  // Refused by the client document: the configured pattern ignores the query.
  'TC4.redirect-with-query-not-in-document': (s) =>
    s.status === 400 &&
    s.location === null &&
    message(s).includes('not registered in client metadata'),
  // Refused by the configured redirect patterns, before the document is consulted.
  'TC4.redirect-of-other-extension': (s) =>
    s.status === 400 &&
    s.location === null &&
    message(s).startsWith('Invalid redirect_uri') &&
    !message(s).includes('not registered'),
  'TC4.loopback-redirect': (s) =>
    s.status === 400 &&
    s.location === null &&
    message(s).startsWith('Invalid redirect_uri') &&
    !message(s).includes('not registered'),
  'TC5.client-not-allowed': (s) =>
    s.status === 400 &&
    s.location === null &&
    message(s).startsWith('Invalid client_id') &&
    s.clientDocumentFetches?.length === 0,
  'B5.two-users': (s, _steps, options) =>
    s.firstUser?.catalog?.byName?.status === 200 &&
    s.secondUser?.sub === options.secondUser &&
    s.secondUser?.catalog?.byName?.status === 404 &&
    s.secondUser?.catalog?.list?.count === 0,
};

/** The ids of the flow steps whose expectation does not hold, or that are missing. */
export function unmetFlowExpectations(steps, options) {
  return Object.entries(FLOW)
    .filter(([id, check]) => !steps[id] || !check(steps[id], steps, options))
    .map(([id]) => (steps[id] ? id : `${id} (step missing)`));
}

/**
 * The backend log facts: the SQLite rotation warning, and the B5 policy attribution that the test
 * permission policy logs as `BVE_USER_PERMISSION_DECISION` lines (`test-permissions.mjs`).
 */
export function unmetHostExpectations(facts, { firstUser, secondUser }) {
  const decisions = (facts?.userPermissionDecisions ?? []).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const decided = (user, result) =>
    decisions.some(
      (row) =>
        row.user === user &&
        row.permission === 'catalog.entity.read' &&
        row.nativeResult === 'ALLOW' &&
        row.result === result,
    );
  return [
    ...(facts?.sqliteRotationWarning === true ? [] : ['sqlite rotation warning logged']),
    ...(decided(firstUser, 'ALLOW') ? [] : [`policy allows ${firstUser}`]),
    ...(decided(secondUser, 'DENY') ? [] : [`policy denies ${secondUser}`]),
    ...(decided(firstUser, 'DENY') || decided(secondUser, 'ALLOW')
      ? ['policy decided the opposite for a user']
      : []),
  ];
}

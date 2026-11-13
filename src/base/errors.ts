export interface ContractIssue {
  readonly path: string;
  readonly message: string;
}

/** Diagnostics deliberately omit source text, credentials, and rejected values. */
export class ContractError extends Error {
  override readonly name = 'ContractError';

  constructor(
    readonly code: 'invalid_json' | 'invalid_contract' | 'integrity' | 'limit' | 'invalid_policy',
    readonly issues: readonly ContractIssue[],
  ) {
    super(`${code}: ${issues.map((issue) => `${issue.path || '/'} ${issue.message}`).join('; ')}`);
  }
}

export function reject(code: ContractError['code'], path: string, message: string): never {
  throw new ContractError(code, [{ path, message }]);
}

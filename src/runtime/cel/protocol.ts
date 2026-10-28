import { isCelErrorCode } from './errors.js';
import type { CelErrorCode } from './errors.js';
import { CEL_PROFILE } from './limits.js';

export interface CelWorkerRequest {
  readonly id: number;
  readonly expression: string;
  readonly entity: unknown;
}

export type CelWorkerReply =
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: boolean }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly ok: false;
      readonly code: CelErrorCode;
    };

export function isReadyMessage(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'ready' &&
    'version' in value &&
    value.version === 1 &&
    'profile' in value &&
    value.profile === CEL_PROFILE
  );
}

export function isWorkerReply(value: unknown, id: number): value is CelWorkerReply {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'result' ||
    !('id' in value) ||
    value.id !== id ||
    !('ok' in value)
  )
    return false;
  return value.ok === true
    ? 'value' in value && typeof value.value === 'boolean'
    : value.ok === false && 'code' in value && isCelErrorCode(value.code);
}

import { Type } from '@sinclair/typebox';
import type { TProperties } from '@sinclair/typebox';

/**
 * TypeBox builders shared by the contract, capability, editor artifact and configuration schemas.
 * No builder has a default limit: a schema that needs a maximum passes it, so moving a call here
 * can never add or remove a bound. Each builder returns a new schema object on every call.
 */

/** An object that rejects every property it does not declare. */
export const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/** A non-empty string. Without `maxLength` the string has no maximum length. */
export const text = (maxLength?: number) =>
  maxLength === undefined
    ? Type.String({ minLength: 1 })
    : Type.String({ minLength: 1, maxLength });

/** A non-negative integer no greater than `Number.MAX_SAFE_INTEGER`. */
export const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A `sha256:` digest of 64 lowercase hexadecimal characters. */
export const digest = () => Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

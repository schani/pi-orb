import { Type } from "typebox";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Arbitrary JSON. Used only for lossless `overflow` payloads whose shape is
 * owned by the harness, never for first-party protocol fields.
 */
export const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());

export const JsonObjectSchema = Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()));

// Zod views of @writ/core's JSON rules, so anything a schema accepts is exactly what `jcs` can hash.
import { assertJsonValue, type JsonValue } from "@writ/core";
import { z } from "zod";

export type JsonObject = { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, "expected a JSON value");
export const JsonObjectSchema = z.custom<JsonObject>(isJsonObject, "expected a JSON object");

import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classifyModelError,
  generateStructured,
  generateStructuredWithFallback,
  ModelRouterError,
  pickRateLimitHeaders,
  type ResolvedModel,
} from "../src/index";

type MockResult = Exclude<ConstructorParameters<typeof MockLanguageModelV4>[0], undefined>["doGenerate"];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
}

function apiError(statusCode: number, message = `HTTP ${statusCode}`, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({ message, url: "https://provider.test/v1/chat", requestBodyValues: {}, statusCode, responseHeaders });
}

function mockModel(doGenerate: MockResult, spec = "groq:mock-model"): { resolved: ResolvedModel; mock: MockLanguageModelV4 } {
  const [provider, modelId] = spec.split(":") as ["groq", string];
  const mock = new MockLanguageModelV4({ provider, modelId, doGenerate });
  return { resolved: { provider, modelId, spec, model: mock }, mock };
}

function failingThenText(error: unknown, text: string): MockResult {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw error;
    return textResult(text);
  };
}

const Draft = z.object({
  budget_minor: z.number().refine(Number.isSafeInteger, "integer"),
  deliver_by: z.string().nullable(),
});

const base = { schema: Draft, schemaName: "WritDraft", instructions: "Compile the request.", prompt: "Gift under $60", maxRetries: 0 };

function promptText(mock: MockLanguageModelV4, call: number): string {
  return JSON.stringify(mock.doGenerateCalls[call]?.prompt ?? null);
}

describe("generateStructured", () => {
  it("returns the parsed value on the first try with temperature 0 and a native schema", async () => {
    const { resolved, mock } = mockModel(textResult('{"budget_minor":6000,"deliver_by":"2026-11-20"}'));
    const result = await generateStructured({ ...base, model: resolved });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ budget_minor: 6000, deliver_by: "2026-11-20" });
    expect(result.mode).toBe("schema");
    expect(result.repaired).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.spec).toBe("groq:mock-model");
    const call = mock.doGenerateCalls[0];
    expect(call?.temperature).toBe(0);
    expect(call?.responseFormat).toMatchObject({ type: "json", name: "WritDraft", schema: { type: "object" } });
    expect(promptText(mock, 0)).toContain("Compile the request.");
  });

  it("repairs once with the rejected text and the reason", async () => {
    const { resolved, mock } = mockModel([
      textResult('{"budget_minor":"sixty dollars","deliver_by":null}'),
      textResult('{"budget_minor":6000,"deliver_by":null}'),
    ]);
    const result = await generateStructured({ ...base, model: resolved });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repaired).toBe(true);
    expect(result.attempts.map((a) => [a.mode, a.ok, a.kind])).toEqual([
      ["schema", false, "invalid_output"],
      ["schema", true, undefined],
    ]);
    expect(result.usage.totalTokens).toBe(30);
    const second = promptText(mock, 1);
    expect(second).toContain("sixty dollars");
    expect(second).toContain("previous reply was rejected");
  });

  it("fails closed after one repair", async () => {
    const { resolved, mock } = mockModel([textResult("not json"), textResult("{still not json")]);
    const result = await generateStructured({ ...base, model: resolved });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("invalid_output");
    expect(result.attempts).toHaveLength(2);
    expect(mock.doGenerateCalls).toHaveLength(2);
  });

  it("switches to JSON mode when the provider rejects the schema", async () => {
    const { resolved, mock } = mockModel(
      failingThenText(apiError(400, "response_format json_schema is not supported"), '{"budget_minor":4000,"deliver_by":null}'),
    );
    const result = await generateStructured({ ...base, model: resolved });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("json");
    expect(result.attempts[0]).toMatchObject({ mode: "schema", ok: false, kind: "schema_rejected", statusCode: 400 });
    const second = mock.doGenerateCalls[1];
    expect(second?.responseFormat).toEqual({ type: "json" });
    expect(promptText(mock, 1)).toContain("budget_minor");
    expect(promptText(mock, 1)).toContain("JSON Schema");
  });

  it("validates JSON mode output with Zod and repairs it", async () => {
    const { resolved } = mockModel([
      textResult('{"budget_minor":12.5,"deliver_by":null}'),
      textResult('{"budget_minor":1250,"deliver_by":null}'),
    ]);
    const result = await generateStructured({ ...base, model: resolved, mode: "json" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts[0]?.kind).toBe("invalid_output");
    expect(result.value.budget_minor).toBe(1250);
  });

  it("does not retry a rate limit and reports it with only the rate-limit headers", async () => {
    const { resolved, mock } = mockModel(async () => {
      throw apiError(429, "Rate limit reached", {
        "retry-after": "7",
        "x-ratelimit-limit-requests": "1000",
        "set-cookie": "session=secret",
      });
    });
    const result = await generateStructured({ ...base, model: resolved });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "rate_limited", statusCode: 429 });
    expect(result.attempts[0]?.rateLimit).toEqual({ "retry-after": "7", "x-ratelimit-limit-requests": "1000" });
    expect(mock.doGenerateCalls).toHaveLength(1);
  });
});

describe("generateStructuredWithFallback", () => {
  it("fails over on transport errors", async () => {
    const first = mockModel(async () => {
      throw apiError(429);
    }, "groq:first");
    const second = mockModel(textResult('{"budget_minor":100,"deliver_by":null}'), "groq:second");
    const result = await generateStructuredWithFallback([first.resolved, second.resolved], base);
    expect(result.ok).toBe(true);
    expect(result.tried).toEqual(["groq:first", "groq:second"]);
    expect(result.spec).toBe("groq:second");
  });

  it("does not shop for another model after an invalid answer", async () => {
    const first = mockModel([textResult("nope"), textResult("nope")], "groq:first");
    const second = mockModel(textResult('{"budget_minor":100,"deliver_by":null}'), "groq:second");
    const result = await generateStructuredWithFallback([first.resolved, second.resolved], base);
    expect(result.ok).toBe(false);
    expect(result.tried).toEqual(["groq:first"]);
    expect(second.mock.doGenerateCalls).toHaveLength(0);
  });

  it("returns the last failure when every model fails", async () => {
    const a = mockModel(async () => {
      throw apiError(503);
    }, "groq:a");
    const b = mockModel(async () => {
      throw apiError(404);
    }, "groq:b");
    const result = await generateStructuredWithFallback([a.resolved, b.resolved], base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("model_not_found");
    expect(result.tried).toEqual(["groq:a", "groq:b"]);
  });

  it("rejects an empty list", async () => {
    await expect(generateStructuredWithFallback([], base)).rejects.toBeInstanceOf(ModelRouterError);
  });
});

describe("pickRateLimitHeaders", () => {
  it("keeps x-ratelimit-* and retry-after only, lower-cased", () => {
    expect(pickRateLimitHeaders({ "X-RateLimit-Remaining-Requests": "9", authorization: "Bearer x", "content-type": "json" })).toEqual({
      "x-ratelimit-remaining-requests": "9",
    });
    expect(pickRateLimitHeaders({ "content-type": "json" })).toBeUndefined();
    expect(pickRateLimitHeaders(undefined)).toBeUndefined();
  });
});

describe("classifyModelError", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "model_not_found"],
    [408, "timeout"],
    [429, "rate_limited"],
    [500, "api_error"],
  ] as const)("HTTP %i → %s", (status, kind) => {
    expect(classifyModelError(apiError(status), "schema").kind).toBe(kind);
  });

  it("treats a 400 as a schema rejection only in schema mode", () => {
    expect(classifyModelError(apiError(400), "schema").kind).toBe("schema_rejected");
    expect(classifyModelError(apiError(400), "json").kind).toBe("api_error");
  });

  it("unwraps RetryError to the last provider error", () => {
    const wrapped = new RetryError({ message: "failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(429)] });
    expect(classifyModelError(wrapped, "schema")).toMatchObject({ kind: "rate_limited", statusCode: 429 });
  });

  it("recognizes timeouts", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(classifyModelError(timeout, "schema").kind).toBe("timeout");
  });

  it("redacts key-shaped text from provider messages", () => {
    const leaked = apiError(401, "Invalid API Key gsk_abcdefghijklmnopqrstuvwxyz0123456789");
    const classified = classifyModelError(leaked, "schema");
    expect(classified.message).not.toContain("gsk_abcdefghij");
    expect(classified.message).toContain("[redacted]");
  });
});

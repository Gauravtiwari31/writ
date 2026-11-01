import { describe, expect, it } from "vitest";
import {
  CatalogError,
  GOOGLE_MODELS_URL,
  GROQ_MODELS_URL,
  listProviderModels,
  OPENROUTER_MODELS_URL,
  parseGoogleModels,
  parseGroqModels,
  parseOpenRouterModels,
  type FetchLike,
} from "../src/index";

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(bodies: unknown[], status = 200): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe("parsers", () => {
  it("keeps only Gemini models that can generateContent and strips the models/ prefix", () => {
    const models = parseGoogleModels([
      {
        models: [
          { name: "models/model-a", displayName: "A", inputTokenLimit: 1000, supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/embed-b", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "t",
      },
      { models: [{ name: "models/model-c", supportedGenerationMethods: ["generateContent"], newField: true }] },
    ]);
    expect(models).toEqual([
      { provider: "google", id: "model-a", name: "A", contextWindow: 1000 },
      { provider: "google", id: "model-c" },
    ]);
  });

  it("drops inactive Groq models", () => {
    const models = parseGroqModels({
      object: "list",
      data: [
        { id: "m1", owned_by: "Lab", active: true, context_window: 131072 },
        { id: "m2", active: false },
      ],
    });
    expect(models).toEqual([{ provider: "groq", id: "m1", name: "Lab", contextWindow: 131072 }]);
  });

  it("marks OpenRouter free variants and structured-output support", () => {
    const models = parseOpenRouterModels({
      data: [
        { id: "lab/a:free", name: "A", context_length: 8000, pricing: { prompt: "0.0001", completion: "0.0002" }, supported_parameters: ["tools"] },
        { id: "lab/b", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs", "response_format"] },
        { id: "lab/c", pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: null },
      ],
    });
    expect(models.map((m) => [m.id, m.free, m.structuredOutputs, m.toolCalling])).toEqual([
      ["lab/a:free", true, false, true],
      ["lab/b", true, true, false],
      ["lab/c", false, false, false],
    ]);
  });

  it("rejects a shape that has no model array", () => {
    expect(() => parseGroqModels({ object: "list" })).toThrow(CatalogError);
  });
});

describe("listProviderModels", () => {
  it("sends the Gemini key in x-goog-api-key, never in the URL, and follows pages", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { models: [{ name: "models/a", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "p2" },
      { models: [{ name: "models/b", supportedGenerationMethods: ["generateContent"] }] },
    ]);
    const models = await listProviderModels("google", "g-key", { fetchImpl });
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url.startsWith(GOOGLE_MODELS_URL)).toBe(true);
      expect(call.url).not.toContain("g-key");
      expect(call.headers["x-goog-api-key"]).toBe("g-key");
    }
    expect(calls[1]?.url).toContain("pageToken=p2");
  });

  it("uses bearer auth for Groq and OpenRouter", async () => {
    const groq = fakeFetch([{ data: [{ id: "m" }] }]);
    await listProviderModels("groq", "q-key", { fetchImpl: groq.fetchImpl });
    expect(groq.calls[0]).toEqual({ url: GROQ_MODELS_URL, headers: { Authorization: "Bearer q-key" } });

    const openrouter = fakeFetch([{ data: [{ id: "m" }] }]);
    await listProviderModels("openrouter", "o-key", { fetchImpl: openrouter.fetchImpl });
    expect(openrouter.calls[0]).toEqual({ url: OPENROUTER_MODELS_URL, headers: { Authorization: "Bearer o-key" } });
  });

  it("turns HTTP errors into CatalogError with the status and a redacted body", async () => {
    const { fetchImpl } = fakeFetch(['{"error":"invalid key gsk_0123456789abcdefghijklmnopqrstuvwxyz"}'], 401);
    const error = await listProviderModels("groq", "q-key", { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).status).toBe(401);
    expect((error as CatalogError).message).not.toContain("gsk_0123456789");
  });
});

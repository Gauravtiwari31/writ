import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPERATURE,
  formatModelSpec,
  ModelRouterError,
  modelFamily,
  parseModelList,
  parseModelSpec,
  PROVIDER_KEY_ENV,
  resolveModels,
  resolveRoleModels,
  ROLES,
  roleEnvName,
  type ModelRouterErrorCode,
  type ProviderFactory,
} from "../src/index";

// Placeholder IDs: the router never interprets them, it only routes them.
const KEYS = {
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-key",
  GROQ_API_KEY: "test-groq-key",
  OPENROUTER_API_KEY: "test-openrouter-key",
};

function expectRouterError(fn: () => unknown, code: ModelRouterErrorCode, fragment?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelRouterError);
    const routerError = error as ModelRouterError;
    expect(routerError.code).toBe(code);
    if (fragment !== undefined) expect(routerError.message).toContain(fragment);
    return;
  }
  throw new Error(`expected ModelRouterError ${code}`);
}

describe("constants", () => {
  it("lists the seven roles from plan §8.1 and uses temperature 0", () => {
    expect(ROLES).toEqual(["compiler", "agent", "reader", "sentinel", "verifier", "analyst", "console"]);
    expect(DEFAULT_TEMPERATURE).toBe(0);
    expect(roleEnvName("sentinel")).toBe("MODEL_SENTINEL");
  });
});

describe("parseModelSpec", () => {
  it("splits provider and model id", () => {
    expect(parseModelSpec("google:model-a")).toEqual({ provider: "google", modelId: "model-a" });
    expect(parseModelSpec("  groq:vendor/model-b  ")).toEqual({ provider: "groq", modelId: "vendor/model-b" });
  });

  it("splits only on the first colon so OpenRouter :free variants survive", () => {
    expect(parseModelSpec("openrouter:vendor/model-c:free")).toEqual({
      provider: "openrouter",
      modelId: "vendor/model-c:free",
    });
  });

  it("normalizes provider case", () => {
    expect(parseModelSpec("Google:model-a").provider).toBe("google");
  });

  it("rejects unknown providers", () => {
    expectRouterError(() => parseModelSpec("openai:model-x"), "UNKNOWN_PROVIDER", "openai");
  });

  it.each(["model-without-provider", ":model", "google:", "google:  ", "google:two words"])("rejects %j", (text) => {
    expectRouterError(() => parseModelSpec(text), "INVALID_SPEC");
  });

  it("round-trips through formatModelSpec", () => {
    expect(formatModelSpec(parseModelSpec("openrouter:a/b:free"))).toBe("openrouter:a/b:free");
  });
});

describe("parseModelList", () => {
  it("keeps order and ignores empty segments", () => {
    expect(parseModelList("google:a, groq:b ,openrouter:c/d:free,")).toEqual([
      { provider: "google", modelId: "a" },
      { provider: "groq", modelId: "b" },
      { provider: "openrouter", modelId: "c/d:free" },
    ]);
  });

  it("rejects an empty list", () => {
    expectRouterError(() => parseModelList(" , ,"), "EMPTY_LIST");
  });

  it("rejects duplicates", () => {
    expectRouterError(() => parseModelList("groq:b,groq:b"), "DUPLICATE_SPEC", "groq:b");
  });

  it("propagates spec errors", () => {
    expectRouterError(() => parseModelList("google:a,mistral:b"), "UNKNOWN_PROVIDER");
  });
});

describe("resolveRoleModels", () => {
  it("builds real provider models in fallback order without any network call", () => {
    const models = resolveRoleModels("compiler", {
      ...KEYS,
      MODEL_COMPILER: "google:model-a,groq:model-b,openrouter:vendor/model-c:free",
    });
    expect(models.map((m) => m.spec)).toEqual(["google:model-a", "groq:model-b", "openrouter:vendor/model-c:free"]);
    expect(models.map((m) => m.model.modelId)).toEqual(["model-a", "model-b", "vendor/model-c:free"]);
    expect(models[0]?.model.provider).toMatch(/^google/);
    expect(models[1]?.model.provider).toMatch(/^groq/);
    expect(models[2]?.model.provider).toBe("openrouter");
  });

  it("passes each provider its own key from env", () => {
    const seen: string[] = [];
    const fake =
      (provider: string): ProviderFactory =>
      (apiKey) => {
        seen.push(`${provider}=${apiKey}`);
        return (modelId) => new MockLanguageModelV4({ provider, modelId });
      };
    const models = resolveRoleModels(
      "verifier",
      { ...KEYS, MODEL_VERIFIER: "groq:x,openrouter:y,groq:z" },
      { factories: { groq: fake("groq"), openrouter: fake("openrouter") } },
    );
    expect(models.map((m) => `${m.model.provider}:${m.model.modelId}`)).toEqual(["groq:x", "openrouter:y", "groq:z"]);
    // One provider instance per provider, created with that provider's key.
    expect(seen).toEqual(["groq=test-groq-key", "openrouter=test-openrouter-key"]);
  });

  it("rejects unknown roles", () => {
    expectRouterError(() => resolveRoleModels("planner", KEYS), "UNKNOWN_ROLE", "planner");
  });

  it("explains how to configure a missing role", () => {
    expectRouterError(() => resolveRoleModels("reader", KEYS), "ROLE_NOT_CONFIGURED", "MODEL_READER is not set");
    expectRouterError(() => resolveRoleModels("reader", { ...KEYS, MODEL_READER: "   " }), "ROLE_NOT_CONFIGURED");
  });

  it("names the env var when the list is malformed", () => {
    expectRouterError(
      () => resolveRoleModels("agent", { ...KEYS, MODEL_AGENT: "anthropic:x" }),
      "UNKNOWN_PROVIDER",
      "MODEL_AGENT:",
    );
  });

  it("names the missing key, the role and the spec, and never echoes other keys", () => {
    const env = { GROQ_API_KEY: "secret-groq", MODEL_SENTINEL: "groq:fast,google:cheap" };
    try {
      resolveRoleModels("sentinel", env);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRouterError);
      const message = (error as Error).message;
      expect((error as ModelRouterError).code).toBe("MISSING_KEY");
      expect(message).toContain(PROVIDER_KEY_ENV.google);
      expect(message).toContain("MODEL_SENTINEL");
      expect(message).toContain("google:cheap");
      expect(message).not.toContain("secret-groq");
    }
  });

  it("treats a whitespace-only key as missing", () => {
    expectRouterError(
      () => resolveModels([{ provider: "openrouter", modelId: "m" }], { OPENROUTER_API_KEY: "  " }),
      "MISSING_KEY",
      "OPENROUTER_API_KEY",
    );
  });
});

describe("modelFamily", () => {
  it.each([
    ["google", "gemini-x-flash", "google"],
    ["openrouter", "google/gemma-x:free", "google"],
    ["groq", "llama-x-versatile", "meta"],
    ["openrouter", "meta-llama/llama-x-instruct:free", "meta"],
    ["groq", "openai/gpt-oss-x", "openai"],
    ["groq", "qwen/qwen-x", "qwen"],
    ["openrouter", "deepseek/deepseek-x:free", "deepseek"],
    ["openrouter", "mistralai/mistral-small-x", "mistral"],
    ["groq", "moonshotai/kimi-x", "moonshot"],
    ["openrouter", "somelab/new-model", "somelab"],
  ] as const)("%s:%s → %s", (provider, modelId, family) => {
    expect(modelFamily({ provider, modelId })).toBe(family);
  });

  it("keeps the same family across hosts so verifier diversity is real", () => {
    expect(modelFamily({ provider: "groq", modelId: "llama-a" })).toBe(
      modelFamily({ provider: "openrouter", modelId: "meta-llama/llama-b" }),
    );
  });
});

// createAiRuntime: plan decision 7 (no keys → still boots, every role unavailable, callers fail
// closed) and the stub contract (configured roles exist; until the ai stream lands they reject with
// NotImplementedError, which every caller already treats as a failure).
import { isNotImplementedError } from "@writ/core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAiRuntime, resolveAllRoles, ROLES } from "../src/index";

const mockFactories = {
  groq: () => (modelId: string) => new MockLanguageModelV4({ provider: "groq", modelId }),
};

describe("createAiRuntime", () => {
  it("boots with no MODEL_* env: every model role is unavailable, the Sentinel is rules-only", () => {
    const runtime = createAiRuntime({ env: {} });
    expect(runtime.compiler).toBeNull();
    expect(runtime.verifier).toBeNull();
    expect(runtime.reader).toBeNull();
    expect(runtime.analyst).toBeNull();
    expect(runtime.agentModels).toBeNull();
    expect(runtime.sentinel).toBeDefined();
    for (const role of ROLES) expect(runtime.status[role], role).toBe("unconfigured");
  });

  it("builds configured roles from MODEL_<ROLE> without calling a model", async () => {
    const env = { MODEL_COMPILER: "groq:mock-a", MODEL_AGENT: "groq:mock-b,groq:mock-c", GROQ_API_KEY: "test-key" };
    const runtime = createAiRuntime({ env, factories: mockFactories });
    expect(runtime.status.compiler).toBe("configured");
    expect(runtime.status.agent).toBe("configured");
    expect(runtime.agentModels?.map((model) => model.spec)).toEqual(["groq:mock-b", "groq:mock-c"]);
    expect(runtime.compiler).not.toBeNull();
    await expect(runtime.compiler?.compile({ text: "gift", addresses: [], existing_writs: [], now: "2026-11-03T14:02:00.000Z" })).rejects.toSatisfy(
      isNotImplementedError,
    );
  });

  it("marks a role with a missing key or a bad spec invalid (no secret values in the message)", () => {
    const resolved = resolveAllRoles({ env: { MODEL_VERIFIER: "groq:model-x", MODEL_ANALYST: "nope", GROQ_API_KEY: "" } });
    expect(resolved.status.verifier).toBe("invalid");
    expect(resolved.status.analyst).toBe("invalid");
    expect(resolved.problems.verifier).toContain("GROQ_API_KEY");
    expect(resolved.models.verifier).toBeNull();
    const runtime = createAiRuntime({ env: { MODEL_VERIFIER: "groq:model-x" } });
    expect(runtime.verifier).toBeNull();
  });
});

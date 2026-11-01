// Model router: every role reads an ordered fallback list of "provider:model-id" specs from
// MODEL_<ROLE>. Model IDs are never hard-coded (plan §8.1, §22 rule 19); keys come from env.
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export const ROLES = ["compiler", "agent", "reader", "sentinel", "verifier", "analyst", "console"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDERS = ["google", "groq", "openrouter"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Temperature 0 everywhere (plan §8.1): reproducible decisions beat creative ones. */
export const DEFAULT_TEMPERATURE = 0;

/** Env var holding each provider's API key. */
export const PROVIDER_KEY_ENV: Readonly<Record<ProviderName, string>> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** A concrete model object (the AI SDK also accepts gateway strings; we never use those). */
export type ModelInstance = Exclude<LanguageModel, string>;

export interface ModelSpec {
  provider: ProviderName;
  modelId: string;
}

export interface ResolvedModel extends ModelSpec {
  /** Canonical "provider:model-id" text, used in logs and decision rows. */
  spec: string;
  model: ModelInstance;
}

export type RouterEnv = Readonly<Record<string, string | undefined>>;

export type ModelRouterErrorCode =
  | "UNKNOWN_ROLE"
  | "INVALID_SPEC"
  | "UNKNOWN_PROVIDER"
  | "DUPLICATE_SPEC"
  | "EMPTY_LIST"
  | "ROLE_NOT_CONFIGURED"
  | "MISSING_KEY";

export class ModelRouterError extends Error {
  override readonly name = "ModelRouterError";
  constructor(
    readonly code: ModelRouterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isProvider(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function roleEnvName(role: Role): string {
  return `MODEL_${role.toUpperCase()}`;
}

export function formatModelSpec(spec: ModelSpec): string {
  return `${spec.provider}:${spec.modelId}`;
}

/**
 * Parses "provider:model-id". Only the first colon separates the provider, because model IDs
 * may contain colons themselves (OpenRouter's ":free" variants).
 */
export function parseModelSpec(text: string): ModelSpec {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) {
    throw new ModelRouterError(
      "INVALID_SPEC",
      `Invalid model spec ${JSON.stringify(text)}: expected "provider:model-id" with provider one of ${PROVIDERS.join(", ")}.`,
    );
  }
  const provider = trimmed.slice(0, colon).trim().toLowerCase();
  const modelId = trimmed.slice(colon + 1).trim();
  if (!isProvider(provider)) {
    throw new ModelRouterError(
      "UNKNOWN_PROVIDER",
      `Unknown provider ${JSON.stringify(provider)} in ${JSON.stringify(text)}; supported providers: ${PROVIDERS.join(", ")}.`,
    );
  }
  if (modelId === "" || /\s/.test(modelId)) {
    throw new ModelRouterError(
      "INVALID_SPEC",
      `Invalid model id in ${JSON.stringify(text)}: it must be non-empty and contain no whitespace.`,
    );
  }
  return { provider, modelId };
}

/** Parses a comma-separated fallback list. Empty segments (e.g. a trailing comma) are ignored. */
export function parseModelList(text: string): ModelSpec[] {
  const specs = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(parseModelSpec);
  if (specs.length === 0) {
    throw new ModelRouterError("EMPTY_LIST", "Model list is empty: expected provider:model-id[,provider:model-id...].");
  }
  const seen = new Set<string>();
  for (const spec of specs) {
    const key = formatModelSpec(spec);
    if (seen.has(key)) {
      throw new ModelRouterError("DUPLICATE_SPEC", `Model ${key} is listed twice in ${JSON.stringify(text)}.`);
    }
    seen.add(key);
  }
  return specs;
}

export type ProviderFactory = (apiKey: string) => (modelId: string) => ModelInstance;

export const DEFAULT_PROVIDER_FACTORIES: Readonly<Record<ProviderName, ProviderFactory>> = {
  google: (apiKey) => {
    const provider = createGoogle({ apiKey });
    return (modelId) => provider(modelId);
  },
  groq: (apiKey) => {
    const provider = createGroq({ apiKey });
    return (modelId) => provider(modelId);
  },
  openrouter: (apiKey) => {
    // "strict" is the mode the provider recommends when talking to the OpenRouter API itself.
    const provider = createOpenRouter({ apiKey, compatibility: "strict", appName: "Writ" });
    return (modelId) => provider.chat(modelId);
  },
};

export interface ResolveOptions {
  factories?: Partial<Record<ProviderName, ProviderFactory>>;
}

function providerKey(provider: ProviderName, env: RouterEnv, context: string): string {
  const name = PROVIDER_KEY_ENV[provider];
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ModelRouterError("MISSING_KEY", `${context} uses provider "${provider}" but ${name} is not set.`);
  }
  return value.trim();
}

/** Builds model objects for explicit specs. No network call happens here. */
export function resolveModels(
  specs: readonly ModelSpec[],
  env: RouterEnv,
  options: ResolveOptions = {},
  context = "Model list",
): ResolvedModel[] {
  const makers = new Map<ProviderName, (modelId: string) => ModelInstance>();
  return specs.map((spec) => {
    const text = formatModelSpec(spec);
    let make = makers.get(spec.provider);
    if (make === undefined) {
      const factory = options.factories?.[spec.provider] ?? DEFAULT_PROVIDER_FACTORIES[spec.provider];
      make = factory(providerKey(spec.provider, env, `${context} (${text})`));
      makers.set(spec.provider, make);
    }
    return { provider: spec.provider, modelId: spec.modelId, spec: text, model: make(spec.modelId) };
  });
}

/** Ordered fallback list for a role, from MODEL_<ROLE>. Throws ModelRouterError on any config problem. */
export function resolveRoleModels(role: string, env: RouterEnv, options: ResolveOptions = {}): ResolvedModel[] {
  if (!isRole(role)) {
    throw new ModelRouterError("UNKNOWN_ROLE", `Unknown role ${JSON.stringify(role)}; roles: ${ROLES.join(", ")}.`);
  }
  const envName = roleEnvName(role);
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    throw new ModelRouterError(
      "ROLE_NOT_CONFIGURED",
      `${envName} is not set. Set it to a comma-separated fallback list such as google:<model-id>,groq:<model-id> ` +
        "(current IDs: pnpm spike spike-models.ts list).",
    );
  }
  let specs: ModelSpec[];
  try {
    specs = parseModelList(raw);
  } catch (error) {
    if (error instanceof ModelRouterError) throw new ModelRouterError(error.code, `${envName}: ${error.message}`);
    throw error;
  }
  return resolveModels(specs, env, options, envName);
}

/**
 * Model family (the lab that trained it), used to keep the Verifier on a different family than
 * the agents (plan §8.1). Hosting provider is irrelevant: Llama on Groq is still Meta.
 */
export function modelFamily(spec: ModelSpec): string {
  const id = spec.modelId.toLowerCase();
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [/gemini|gemma|palm|learnlm/, "google"],
    [/llama|muse/, "meta"],
    [/gpt|o\d-|openai|whisper/, "openai"],
    [/qwen|qwq/, "qwen"],
    [/deepseek/, "deepseek"],
    [/mistral|mixtral|ministral|codestral|devstral|magistral/, "mistral"],
    [/kimi|moonshot/, "moonshot"],
    [/claude|anthropic/, "anthropic"],
    [/glm|zhipu|z-ai/, "zhipu"],
    [/grok|x-ai/, "xai"],
    [/phi-|microsoft/, "microsoft"],
    [/nemotron|nvidia/, "nvidia"],
    [/command|cohere/, "cohere"],
  ];
  for (const [pattern, family] of rules) {
    if (pattern.test(id)) return family;
  }
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  return spec.provider === "google" ? "google" : `unknown:${id}`;
}

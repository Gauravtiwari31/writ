// Live model catalogs, so IDs are copied from the providers themselves (§22 rule 19).
// Vendor responses are parsed loosely: new fields must not break us.
import { z } from "zod";
import { safeErrorText } from "./redact";
import type { ProviderName } from "./router";

export const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface CatalogModel {
  provider: ProviderName;
  id: string;
  name?: string;
  contextWindow?: number;
  /** true/false only when the catalog says so; undefined means "not reported". */
  free?: boolean;
  structuredOutputs?: boolean;
  toolCalling?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CatalogError extends Error {
  override readonly name = "CatalogError";
  constructor(
    readonly provider: ProviderName,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

const GoogleModelsPage = z.looseObject({
  models: z
    .array(
      z.looseObject({
        name: z.string(),
        baseModelId: z.string().optional(),
        displayName: z.string().optional(),
        inputTokenLimit: z.number().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const GroqModels = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      owned_by: z.string().optional(),
      active: z.boolean().optional(),
      context_window: z.number().optional(),
    }),
  ),
});

const OpenRouterModels = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      pricing: z.looseObject({ prompt: z.string().optional(), completion: z.string().optional() }).optional(),
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

async function getJson(
  provider: ProviderName,
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CatalogError(provider, undefined, `${provider} model list request failed: ${safeErrorText(String(error))}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new CatalogError(
      provider,
      response.status,
      `${provider} model list returned HTTP ${response.status}: ${safeErrorText(body, 200)}`,
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CatalogError(provider, response.status, `${provider} model list returned non-JSON`);
  }
}

function parseOrThrow<S extends z.ZodType>(provider: ProviderName, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CatalogError(provider, undefined, `${provider} model list has an unexpected shape: ${parsed.error.message.slice(0, 200)}`);
  }
  return parsed.data;
}

/** Gemini models that can serve generateContent. The key goes in x-goog-api-key, never the URL. */
export function parseGoogleModels(pages: readonly unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const page of pages) {
    for (const model of parseOrThrow("google", GoogleModelsPage, page).models ?? []) {
      if (!(model.supportedGenerationMethods ?? []).includes("generateContent")) continue;
      out.push({
        provider: "google",
        id: model.name.replace(/^models\//, ""),
        ...(model.displayName === undefined ? {} : { name: model.displayName }),
        ...(model.inputTokenLimit === undefined ? {} : { contextWindow: model.inputTokenLimit }),
      });
    }
  }
  return out;
}

export function parseGroqModels(data: unknown): CatalogModel[] {
  return parseOrThrow("groq", GroqModels, data)
    .data.filter((model) => model.active !== false)
    .map((model) => ({
      provider: "groq" as const,
      id: model.id,
      ...(model.owned_by === undefined ? {} : { name: model.owned_by }),
      ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
    }));
}

function isZeroPrice(value: string | undefined): boolean {
  return value !== undefined && Number(value) === 0;
}

export function parseOpenRouterModels(data: unknown): CatalogModel[] {
  return parseOrThrow("openrouter", OpenRouterModels, data).data.map((model) => {
    const params = model.supported_parameters ?? [];
    const free = model.id.endsWith(":free") || (isZeroPrice(model.pricing?.prompt) && isZeroPrice(model.pricing?.completion));
    return {
      provider: "openrouter" as const,
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.context_length == null ? {} : { contextWindow: model.context_length }),
      free,
      structuredOutputs: params.includes("structured_outputs") || params.includes("response_format"),
      toolCalling: params.includes("tools"),
    };
  });
}

export interface ListModelsOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function listProviderModels(
  provider: ProviderName,
  apiKey: string,
  options: ListModelsOptions = {},
): Promise<CatalogModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  switch (provider) {
    case "google": {
      const pages: unknown[] = [];
      let pageToken: string | undefined;
      // Bounded loop: the catalog is small, a runaway token must not spin forever.
      for (let page = 0; page < 20; page += 1) {
        const url = new URL(GOOGLE_MODELS_URL);
        url.searchParams.set("pageSize", "1000");
        if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
        const data = await getJson(provider, url.toString(), { "x-goog-api-key": apiKey }, fetchImpl, timeoutMs);
        pages.push(data);
        pageToken = parseOrThrow(provider, GoogleModelsPage, data).nextPageToken;
        if (pageToken === undefined || pageToken === "") break;
      }
      return parseGoogleModels(pages);
    }
    case "groq":
      return parseGroqModels(
        await getJson(provider, GROQ_MODELS_URL, { Authorization: `Bearer ${apiKey}` }, fetchImpl, timeoutMs),
      );
    case "openrouter":
      return parseOpenRouterModels(
        await getJson(provider, OPENROUTER_MODELS_URL, { Authorization: `Bearer ${apiKey}` }, fetchImpl, timeoutMs),
      );
  }
}

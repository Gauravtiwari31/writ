// The tool loop shared by Atlas and Scout. An agent is untrusted by design: its only reach is the public
// agent API through AgentApiClient, no tool has a payee, amount or raw address parameter (§22 rule 8), and
// whatever it does, the gateway decides. Every page it reads is declared as a source, so the Sentinel
// scans it even when the agent would rather not say.
import { randomUUID } from "node:crypto";
import { preprocessHtml, type ResolvedModel } from "@writ/ai";
import type { CartSource } from "@writ/core";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { AgentApiError, type AgentApiClient } from "./client";
import type { AgentRunContext, AgentRunResult, PageReader } from "./types";

export const DEFAULT_MAX_STEPS = 12;

export interface LoopConfig {
  kind: "atlas" | "scout";
  instructions: string;
  models: readonly ResolvedModel[];
  client: AgentApiClient;
  pageReader: PageReader;
  maxSteps?: number;
  /** What the model gets back from read_page: Atlas gets the raw text, Scout only typed facts. */
  pageForModel(url: string, html: string, productRefHint: string | null): Promise<unknown>;
  /** What the model sees of a search result title. */
  titleForModel(title: string): string;
}

function errorSummary(error: unknown): string {
  if (error instanceof AgentApiError) return `${error.code}: ${error.message}`.slice(0, 500);
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function titleOf(html: string): string | null {
  return html.match(/<title[^>]*>([^<]{0,200})/i)?.[1]?.trim() ?? null;
}

export async function runLoop(config: LoopConfig, context: AgentRunContext): Promise<AgentRunResult> {
  const { client, pageReader } = config;
  const sources: CartSource[] = [];
  let purchaseId: string | null = null;
  let budgetSpent = false;

  const called = (name: "get_writ" | "search_products" | "read_page" | "propose_cart" | "checkout", input: Record<string, unknown>) => context.emit({ type: "tool.called", tool: name, input });
  const result = (name: "get_writ" | "search_products" | "read_page" | "propose_cart" | "checkout", ok: boolean, summary: string) => context.emit({ type: "tool.result", tool: name, ok, summary: summary.slice(0, 500) });

  const tools = {
    get_writ: tool({
      description: "Read the signed Writ: what you may buy, the budget and the shipping address reference.",
      inputSchema: z.object({}),
      execute: async () => {
        await called("get_writ", {});
        const writ = await client.getWrit(context.writId);
        await result("get_writ", true, writ.summary.join("; "));
        return { status: writ.status, summary: writ.summary, ship_to_ref: writ.writ.ship_to.ref, ship_to_label: writ.writ.ship_to.label, remaining_minor: writ.budget.remaining_minor };
      },
    }),
    search_products: tool({
      description: "Search products. Returns product_ref, title, price in minor units, category and URL.",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      execute: async ({ query }) => {
        await called("search_products", { query });
        const found = await client.search({ writ_id: context.writId as never, query, limit: 8 });
        await context.emit({
          type: "search.results",
          query,
          source: found.source,
          items: found.results.map((item) => ({ product_ref: item.product_ref, title: item.title, price_minor: item.price_minor, merchant_id: item.merchant_id })),
        });
        return {
          notice: found.notice,
          results: found.results.map((item) => ({ product_ref: item.product_ref, title: config.titleForModel(item.title), price_minor: item.price_minor, category: item.category, kind: item.kind, url: item.url })),
        };
      },
    }),
    read_page: tool({
      description: "Read a web page, for example a deals or product page.",
      inputSchema: z.object({ url: z.string().min(1).max(2048), product_ref: z.string().max(128).nullish() }),
      execute: async ({ url, product_ref: productRef }) => {
        await called("read_page", { url });
        try {
          const page = await pageReader.read(url, context.signal);
          sources.push({ url: page.url, kind: "page", fetched_at: new Date().toISOString() as CartSource["fetched_at"], product_ref: productRef ?? null });
          const text = preprocessHtml(page.html);
          await context.emit({ type: "page.read", url: page.url, title: titleOf(page.html), visible_chars: text.visible.length, hidden_chars: text.hidden.length });
          return await config.pageForModel(page.url, page.html, productRef ?? null);
        } catch (error) {
          await result("read_page", false, errorSummary(error));
          return { error: "could not read the page" };
        }
      },
    }),
    propose_cart: tool({
      description: "Propose a cart for the Writ. You only choose products, quantities and an address reference; the gateway sets prices and tells you what passes.",
      inputSchema: z.object({ items: z.array(z.object({ product_ref: z.string().max(128), qty: z.number().int().min(1).max(99) })).min(1).max(20), ship_to_ref: z.string().max(64) }),
      execute: async ({ items, ship_to_ref: shipToRef }) => {
        await called("propose_cart", { items, ship_to_ref: shipToRef });
        try {
          const proposed = await client.proposeCart({ writ_id: context.writId as never, items, ship_to_ref: shipToRef as never, sources: sources.slice(-50) });
          await context.emit({ type: "cart.proposed", cart_id: proposed.cart_id, total_minor: proposed.cart.total_minor, verdict: proposed.preview.verdict, reasons: proposed.preview.reasons });
          return { cart_id: proposed.cart_id, total_minor: proposed.cart.total_minor, verdict: proposed.preview.verdict, reasons: proposed.preview.reasons };
        } catch (error) {
          await result("propose_cart", false, errorSummary(error));
          return { error: errorSummary(error) };
        }
      },
    }),
    checkout: tool({
      description: "Check out a proposed cart. The gateway decides: a BLOCK comes back with typed reasons so you can re-plan.",
      inputSchema: z.object({ cart_id: z.string().max(64) }),
      execute: async ({ cart_id: cartId }) => {
        await called("checkout", { cart_id: cartId });
        try {
          const { result: outcome } = await client.checkout({ cart_id: cartId as never }, `${config.kind}-${randomUUID()}`);
          purchaseId = outcome.purchase_id;
          await context.emit({ type: "checkout.result", purchase_id: outcome.purchase_id, status: outcome.status, verdict: outcome.verdict, money_moved: outcome.money_moved });
          return { purchase_id: outcome.purchase_id, status: outcome.status, verdict: outcome.verdict, reasons: outcome.reasons, policy_reasons: outcome.policy_reasons, money_moved: outcome.money_moved };
        } catch (error) {
          await result("checkout", false, errorSummary(error));
          return { error: errorSummary(error) };
        }
      },
    }),
  };

  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
  let lastError: unknown = null;
  for (const model of config.models) {
    let steps = 0;
    let tokens = 0;
    const budget = new AbortController();
    try {
      const answer = await generateText({
        model: model.model,
        temperature: 0,
        system: config.instructions,
        prompt: `Your task: ${context.goal}\nWrit id: ${context.writId}. Start with get_writ. Stop after one checkout that is not blocked.`,
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: AbortSignal.any([context.signal, budget.signal]),
        prepareStep: async () => {
          if (!(await context.consumeLlmCall())) {
            budgetSpent = true;
            budget.abort();
          }
          return {};
        },
      });
      steps = answer.steps.length;
      tokens = answer.totalUsage.totalTokens ?? 0;
      if (answer.text.trim() !== "") await context.emit({ type: "agent.message", text: answer.text.slice(0, 2000) });
      const finished = answer.steps.at(-1)?.finishReason !== "tool-calls";
      return {
        status: finished ? "SUCCEEDED" : "FAILED",
        failure_code: finished ? null : "step_limit",
        failure_detail: finished ? null : `Stopped after ${maxSteps} steps.`,
        purchase_id: purchaseId,
        steps,
        tokens,
      };
    } catch (error) {
      lastError = error;
      if (context.signal.aborted) return { status: "CANCELLED", failure_code: null, failure_detail: null, purchase_id: purchaseId, steps, tokens };
      if (budgetSpent) return { status: "FAILED", failure_code: "rate_limited", failure_detail: "The daily model budget is spent.", purchase_id: purchaseId, steps, tokens };
    }
  }
  return { status: "FAILED", failure_code: "gateway_error", failure_detail: errorSummary(lastError), purchase_id: purchaseId, steps: 0, tokens: 0 };
}


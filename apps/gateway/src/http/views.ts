// Row → API view mappers for the views several streams emit or serve, so an SSE event and a GET
// answer agree field for field (docs/ARCHITECTURE.md §7):
//   purchaseView  money (purchase.updated on every saga transition), api (GET /v1/purchases),
//                 evidence (ReceiptView.purchase), console (datasets)
//   budgetView    money (budget.updated on reserve/settle/release), api (WritView.budget, signing)
//   decisionView  api (pipeline stages), money (the "human" row)
//   attackView    api (Sentinel), console
// Each view is parsed with its strict @writ/core/api schema, so drift between a table and its
// view fails loudly (test/views.test.ts). Money stays bigint until here: amounts leave as strings.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md): streams call these, never re-map by hand.
import {
  AttackViewSchema,
  BudgetViewSchema,
  DecisionViewSchema,
  PurchaseViewSchema,
  type AttackView,
  type BudgetView,
  type DecisionView,
  type PurchaseView,
} from "@writ/core/api";
import type { Attack, Decision, Purchase, WritBudget } from "../db/schema";

export function purchaseView(row: Purchase): PurchaseView {
  return PurchaseViewSchema.parse({
    purchase_id: row.id,
    writ_id: row.writId,
    cart_id: row.cartId,
    agent_id: row.agentId,
    state: row.state,
    state_reason: row.stateReason,
    amount_minor: row.amountMinor.toString(),
    currency: row.currency,
    final_verdict: row.finalVerdict,
    paypal: {
      order_id: row.paypalOrderId,
      authorization_id: row.authorizationId,
      capture_id: row.captureId,
      refund_id: row.refundId,
    },
    synthetic: row.synthetic,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

export function budgetView(row: WritBudget): BudgetView {
  return BudgetViewSchema.parse({
    writ_id: row.writId,
    limit_minor: row.limitMinor.toString(),
    max_per_order_minor: row.maxPerOrderMinor.toString(),
    reserved_minor: row.reservedMinor.toString(),
    spent_minor: row.spentMinor.toString(),
    remaining_minor: (row.limitMinor - row.spentMinor - row.reservedMinor).toString(),
    orders_count: row.ordersCount,
    held_orders: row.heldOrders,
    max_orders: row.maxOrders,
  });
}

export function decisionView(row: Decision): DecisionView {
  return DecisionViewSchema.parse({
    decision_id: row.id,
    purchase_id: row.purchaseId,
    cart_id: row.cartId,
    stage: row.stage,
    verdict: row.verdict,
    reasons: row.reasons,
    model: row.model,
    latency_ms: row.latencyMs,
    tokens: row.tokens,
    created_at: row.createdAt.toISOString(),
  });
}

export function attackView(row: Attack): AttackView {
  return AttackViewSchema.parse({
    attack_id: row.id,
    source_url: row.sourceUrl,
    category: row.category,
    spans: row.spans,
    score: row.score,
    detector: row.detector,
    cart_id: row.cartId,
    purchase_id: row.purchaseId,
    agent_id: row.agentId,
    synthetic: row.synthetic,
    created_at: row.createdAt.toISOString(),
  });
}

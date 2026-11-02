// The gateway route table (docs/ARCHITECTURE.md §4). The contract between the gateway streams and
// the Wallet/console/agents: paths and auth are frozen; request/response bodies are the named
// schemas in @writ/core/api. A stream may ADD routes in its own plugin file, never rename these.
// test/routes.test.ts asserts every row is registered.

export type RouteMethod = "GET" | "POST" | "DELETE";
export type RouteAuth = "none" | "session" | "judge-session" | "agent-key" | "paypal-signature" | "capability-token";
export type RouteOwner = "architect" | "api" | "money" | "agents" | "evidence" | "web-flows" | "console" | "judge";

export interface RouteSpec {
  readonly method: RouteMethod;
  readonly url: string;
  readonly owner: RouteOwner;
  readonly auth: RouteAuth;
  /** @writ/core/api schema of the JSON body, or null. */
  readonly request: string | null;
  /** @writ/core/api schema of the 2xx body (or a description for non-JSON answers). */
  readonly response: string;
  /** Plugin file under src/routes. */
  readonly file: string;
}

const r = (
  method: RouteMethod,
  url: string,
  owner: RouteOwner,
  auth: RouteAuth,
  request: string | null,
  response: string,
  file: string,
): RouteSpec => ({ method, url, owner, auth, request, response, file });

export const ROUTE_TABLE: readonly RouteSpec[] = [
  r("GET", "/healthz", "architect", "none", null, "HEALTH_BODY", "health.ts"),
  r("GET", "/v1/meta", "architect", "none", null, "MetaResponse", "meta.ts"),

  r("POST", "/v1/auth/register/options", "api", "none", "RegisterOptionsRequest", "RegisterOptionsResponse", "auth.ts"),
  r("POST", "/v1/auth/register/verify", "api", "none", "RegisterVerifyRequest", "SessionView + Set-Cookie", "auth.ts"),
  r("POST", "/v1/auth/login/options", "api", "none", null, "LoginOptionsResponse", "auth.ts"),
  r("POST", "/v1/auth/login/verify", "api", "none", "LoginVerifyRequest", "SessionView + Set-Cookie", "auth.ts"),
  r("POST", "/v1/auth/logout", "api", "session", null, "204 + cleared cookie", "auth.ts"),
  r("GET", "/v1/me", "api", "session", null, "MeResponse", "auth.ts"),
  r("POST", "/v1/auth/device-keys", "api", "session", "RegisterDeviceKeyRequest", "DeviceKeyView", "auth.ts"),
  r("GET", "/v1/address-book", "api", "session", null, "AddressListResponse", "auth.ts"),
  r("POST", "/v1/address-book", "api", "session", "CreateAddressRequest", "AddressDetail", "auth.ts"),

  r("POST", "/v1/writs/compile", "api", "session", "CompileRequest", "CompileResponse (503 ai_unavailable)", "writs.ts"),
  r("POST", "/v1/writs", "api", "session", "CreateWritRequest", "CreateWritResponse", "writs.ts"),
  r("GET", "/v1/writs", "api", "session", null, "ListWritsResponse", "writs.ts"),
  r("GET", "/v1/writs/:id", "api", "session", null, "WritView", "writs.ts"),
  r("POST", "/v1/writs/:id/sign", "api", "session", "SignWritRequest", "WritView", "writs.ts"),
  r("POST", "/v1/writs/:id/revoke", "api", "session", "RevokeWritRequest", "WritView", "writs.ts"),
  r("POST", "/v1/kill-switch", "api", "session", "KillSwitchRequest", "KillSwitchResponse", "writs.ts"),

  r("POST", "/v1/agents", "api", "session", "CreateAgentRequest", "CreateAgentResponse", "agents.ts"),
  r("GET", "/v1/agents", "api", "session", null, "ListAgentsResponse", "agents.ts"),
  r("POST", "/v1/agents/:id/revoke", "api", "session", null, "AgentView", "agents.ts"),
  r("POST", "/v1/agents/:id/rotate-key", "api", "session", null, "CreateAgentResponse", "agents.ts"),

  r("GET", "/v1/agent/writs", "api", "agent-key", null, "AgentWritListResponse", "agent-api.ts"),
  r("GET", "/v1/agent/writs/:id", "api", "agent-key", null, "AgentWritView", "agent-api.ts"),
  r("POST", "/v1/agent/search", "api", "agent-key", "AgentSearchRequest", "AgentSearchResponse", "agent-api.ts"),
  r("GET", "/v1/agent/products/:ref", "api", "agent-key", null, "AgentProductResponse", "agent-api.ts"),
  r("POST", "/v1/agent/carts", "api", "agent-key", "ProposeCartRequest", "ProposeCartResponse", "agent-api.ts"),
  r("POST", "/v1/agent/checkout", "api", "agent-key", "CheckoutRequest + Idempotency-Key", "CheckoutResponse (403 when BLOCKED)", "agent-api.ts"),
  r("GET", "/v1/agent/purchases/:id", "api", "agent-key", null, "AgentPurchaseView", "agent-api.ts"),

  r("GET", "/v1/purchases", "api", "session", null, "ListPurchasesResponse", "purchases.ts"),
  r("GET", "/v1/purchases/:id", "api", "session", null, "PurchaseDetailResponse", "purchases.ts"),
  r("GET", "/v1/stream", "api", "session", null, "text/event-stream of StreamMessage", "stream.ts"),

  r("GET", "/v1/approvals", "money", "session", null, "ListApprovalsResponse", "approvals.ts"),
  r("GET", "/v1/approvals/:id", "money", "session", null, "ApprovalChallengeResponse", "approvals.ts"),
  r("POST", "/v1/approvals/:id/decide", "money", "session", "DecideApprovalRequest", "DecideApprovalResponse", "approvals.ts"),
  r("POST", "/v1/webhooks/paypal", "money", "paypal-signature", "PayPal event (raw)", "{ received, event_id }", "webhooks.ts"),

  r("GET", "/v1/paypal/config", "web-flows", "session", null, "PayPalConfigResponse", "paypal.ts"),
  r("GET", "/v1/paypal/vault", "web-flows", "session", null, "VaultStatusView", "paypal.ts"),
  r("POST", "/v1/paypal/vault/setup-token", "web-flows", "session", "CreateSetupTokenRequest", "CreateSetupTokenResponse", "paypal.ts"),
  r("POST", "/v1/paypal/vault/payment-token", "web-flows", "session", "CreatePaymentTokenRequest", "VaultStatusView", "paypal.ts"),
  r("POST", "/v1/paypal/vault/disconnect", "web-flows", "session", null, "VaultStatusView", "paypal.ts"),

  r("POST", "/v1/runs", "agents", "session", "StartRunRequest", "RunView (202)", "runs.ts"),
  r("GET", "/v1/runs", "agents", "session", null, "ListRunsResponse", "runs.ts"),
  r("GET", "/v1/runs/:id", "agents", "session", null, "RunDetailResponse", "runs.ts"),
  r("POST", "/v1/runs/:id/stop", "agents", "session", null, "RunView", "runs.ts"),

  r("POST", "/v1/evidence-links", "evidence", "session", "CreateEvidenceLinkRequest", "EvidenceLinkView", "evidence.ts"),
  r("GET", "/v1/evidence/:file", "evidence", "capability-token", null, "<token>.json → EvidencePack · <token>.pdf → application/pdf", "evidence.ts"),
  r("GET", "/v1/receipts/:purchaseId", "evidence", "session", null, "ReceiptView", "evidence.ts"),
  r("GET", "/v1/disputes", "evidence", "session", null, "ListDisputesResponse", "disputes.ts"),
  r("GET", "/v1/disputes/:id", "evidence", "session", null, "DisputeDetailResponse", "disputes.ts"),
  r("POST", "/v1/disputes/:id/actions", "evidence", "session", "DisputeActionRequest", "DisputeView", "disputes.ts"),
  r("POST", "/v1/demo/disputes/:purchaseId/simulate", "evidence", "session", "SimulateDisputeRequest", "DisputeView", "disputes.ts"),

  r("GET", "/api/console/datasets/:name", "console", "session", null, "ConsoleDatasetResponse", "console.ts"),
  r("POST", "/api/console/query", "console", "session", "ConsoleQueryRequest", "ConsoleQueryResponse", "console.ts"),
  r("POST", "/api/ai/studio", "console", "session", "OpenAI Responses request (proxied)", "provider response (proxied)", "console.ts"),

  r("POST", "/v1/demo/session", "judge", "none", null, "DemoSessionResponse + Set-Cookie", "demo.ts"),
  r("GET", "/v1/demo/status", "judge", "none", null, "DemoStatusResponse", "demo.ts"),
  r("POST", "/v1/demo/hero-run", "judge", "judge-session", null, "RunView (202; 429 over the hourly limit)", "demo.ts"),
];

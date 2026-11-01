// Sandbox-only configuration (§22 rule 21). The base URL is a constant, not an env var, so no
// configuration mistake can point this client at live PayPal.

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  readonly env: "sandbox";
  readonly baseUrl: typeof PAYPAL_SANDBOX_BASE_URL;
  readonly clientId: string;
  /** Non-enumerable: JSON.stringify and console.log of the config never show it. */
  readonly clientSecret: string;
}

export class PayPalConfigError extends Error {
  override readonly name = "PayPalConfigError";
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Throws unless PAYPAL_ENV is exactly "sandbox" and both credentials are present. Never echoes secret values. */
export function loadPayPalConfig(env: EnvSource = process.env): PayPalConfig {
  const mode = read(env, "PAYPAL_ENV");
  if (mode !== "sandbox") {
    const got = mode === undefined ? "it is not set" : `got ${JSON.stringify(mode)}`;
    throw new PayPalConfigError(
      `PAYPAL_ENV must be "sandbox" (${got}). Writ only ever talks to the PayPal sandbox (plan §22 rule 21).`,
    );
  }
  const clientId = read(env, "PAYPAL_CLIENT_ID");
  const clientSecret = read(env, "PAYPAL_CLIENT_SECRET");
  const missing = [
    clientId === undefined ? "PAYPAL_CLIENT_ID" : null,
    clientSecret === undefined ? "PAYPAL_CLIENT_SECRET" : null,
  ].filter((name): name is string => name !== null);
  if (clientId === undefined || clientSecret === undefined) {
    throw new PayPalConfigError(
      `Missing ${missing.join(" and ")}. Copy them from the sandbox REST app in the PayPal Developer Dashboard into .env.`,
    );
  }
  return makePayPalConfig(clientId, clientSecret);
}

/** Builds a config directly (tests, or callers that already hold the credentials). */
export function makePayPalConfig(clientId: string, clientSecret: string): PayPalConfig {
  if (clientId === "" || clientSecret === "") throw new PayPalConfigError("PayPal client id and secret must be non-empty");
  const config = { env: "sandbox", baseUrl: PAYPAL_SANDBOX_BASE_URL, clientId } as PayPalConfig;
  Object.defineProperty(config, "clientSecret", { value: clientSecret, enumerable: false, writable: false });
  return Object.freeze(config);
}

/** Defense in depth for configs built by hand: anything that is not the sandbox is refused. */
export function assertSandbox(config: PayPalConfig): void {
  if (config.env !== "sandbox" || config.baseUrl !== PAYPAL_SANDBOX_BASE_URL) {
    throw new PayPalConfigError(`Refusing to use PayPal at ${String(config.baseUrl)}: sandbox only (plan §22 rule 21).`);
  }
}

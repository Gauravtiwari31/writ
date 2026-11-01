// Provider error messages are printed and stored; scrub anything key-shaped first (§22 rule 20).
const SECRET_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /gsk_[0-9A-Za-z]{10,}/g, // Groq
  /sk-or-[0-9A-Za-z_-]{10,}/g, // OpenRouter
  /sk-[0-9A-Za-z_-]{20,}/g, // OpenAI-style keys some gateways echo
  /Bearer\s+[0-9A-Za-z._~+/=-]{8,}/gi,
  /([?&](?:key|api_key|apikey|token)=)[^&\s"]+/gi,
  /[0-9A-Za-z_]{40,}/g, // any other long opaque token
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match: string, prefix: unknown) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
}

/** Redacts, collapses whitespace and caps length so one provider error can't flood a log line. */
export function safeErrorText(text: string, maxChars = 300): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

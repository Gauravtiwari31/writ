// The one fetcher of untrusted pages (read_page tool and the Sentinel). It runs inside the gateway, so it
// refuses anything but http(s), refuses private, loopback and link-local targets unless the origin is
// explicitly allowed (the Wallet's /fixtures route in local runs), re-checks every redirect and caps size
// and time. A DNS name is resolved and every address checked before the request.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PageReader } from "./types";

export interface PageReaderOptions {
  /** Origins allowed even when they resolve to loopback (the Wallet /fixtures route in local runs). */
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam. */
  fetch?: typeof fetch;
  /** Test seam. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
}

const MAX_REDIRECTS = 5;

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || /^fe[89ab]/.test(ip) || ip.startsWith("ff");
}

export function createPageReader(options: PageReaderOptions): PageReader {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const fetchImpl = options.fetch ?? fetch;
  const resolve = options.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map((entry) => entry.address));
  const allowed = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));

  async function assertAllowed(url: URL): Promise<void> {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`refused scheme ${url.protocol}`);
    if (allowed.has(url.origin)) return;
    if (url.username !== "" || url.password !== "") throw new Error("refused credentials in URL");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) !== 0 ? [hostname] : await resolve(hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(`refused private address for ${hostname}`);
  }

  return {
    async read(url, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
      let current = new URL(url);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertAllowed(current);
        const response = await fetchImpl(current, { redirect: "manual", signal: combined, headers: { accept: "text/html,*/*;q=0.5", "user-agent": "WritPageReader/0.1" } });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (location === null) throw new Error("redirect without a location");
          await response.body?.cancel();
          current = new URL(location, current);
          continue;
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (reader !== undefined) {
          const { done, value } = await reader.read();
          if (done || value === undefined) break;
          const room = maxBytes - total;
          chunks.push(value.subarray(0, Math.max(0, room)));
          total += value.length;
          if (total >= maxBytes) {
            await reader.cancel();
            break;
          }
        }
        const html = Buffer.concat(chunks).toString("utf8");
        return { url: current.toString(), status: response.status, html, fetched_at: new Date().toISOString() };
      }
      throw new Error("too many redirects");
    },
  };
}

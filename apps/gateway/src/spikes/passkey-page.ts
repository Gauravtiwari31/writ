// HTML for spike S6 (plan §17). One self-contained page: inline CSS and JS, plus the pinned
// @simplewebauthn/browser UMD bundle from jsDelivr with Subresource Integrity.
// The inline script and style are static so their CSP hashes are computed once; per-request data
// travels in a JSON data block, which the browser never executes.
import { createHash } from "node:crypto";

/**
 * Pinned browser bundle. Exposes `window.SimpleWebAuthnBrowser` (startRegistration,
 * startAuthentication, browserSupportsWebAuthn, platformAuthenticatorIsAvailable).
 * The integrity value is sha384 over the exact bytes served for this version; jsDelivr and unpkg
 * serve identical bytes for it.
 */
export const SIMPLEWEBAUTHN_BROWSER_CDN = {
  version: "14.0.0",
  url: "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@14.0.0/dist/bundle/index.umd.min.js",
  integrity: "sha384-06g944bCm8L/wG3i0Q8PdB8jccE4GdpHdNCa1tJY8eMqoP3GIHGJdL6B5lD5OMGD",
} as const;

export interface PasskeyPageConfig {
  /** Absolute path the spike routes are mounted under, e.g. "/spikes/passkey". */
  basePath: string;
  rpID: string;
  rpName: string;
  /** Origins the server will accept in clientDataJSON for this request. */
  expectedOrigins: string[];
  sampleWrit: unknown;
  sampleHashHex: string;
  tamper: { path: string; from: string; to: string };
}

const PAGE_STYLE = `
:root {
  --bg: #f6f5f2; --card: #ffffff; --fg: #17181c; --muted: #5d6270; --line: #e2e1dc;
  --accent: #1d4ed8; --accent-fg: #ffffff;
  --ok: #0f6b3a; --ok-bg: #e5f3ea; --bad: #b42318; --bad-bg: #fdecea; --warn: #7a4f00; --warn-bg: #fff3d6;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1114; --card: #171a1f; --fg: #e9eaee; --muted: #a0a6b3; --line: #2a2f37;
    --accent: #6d95ff; --accent-fg: #0b0d10;
    --ok: #6fd69b; --ok-bg: #12291c; --bad: #ff8a80; --bad-bg: #2f1513; --warn: #ffd27a; --warn-bg: #2d2412;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 var(--sans); }
main { max-width: 760px; margin: 0 auto; padding: 16px 16px 48px; }
h1 { font-size: 1.35rem; margin: 8px 0 4px; }
h2 { font-size: 1.05rem; margin: 0 0 8px; }
p { margin: 6px 0; }
.label { display: inline-block; font: 600 12px/1 var(--sans); letter-spacing: .06em; text-transform: uppercase;
  color: var(--warn); background: var(--warn-bg); padding: 6px 8px; border-radius: 6px; }
.muted { color: var(--muted); font-size: .92rem; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 16px 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
button { font: 600 15px/1.2 var(--sans); padding: 12px 16px; border-radius: 10px; border: 1px solid var(--accent);
  background: var(--accent); color: var(--accent-fg); cursor: pointer; flex: 1 1 220px; min-height: 44px; }
button.secondary { background: transparent; color: var(--accent); }
button:disabled { opacity: .45; cursor: not-allowed; }
fieldset { border: 0; padding: 0; margin: 8px 0; display: flex; flex-wrap: wrap; gap: 4px 16px; }
legend { font-weight: 600; margin-bottom: 4px; }
label { display: inline-flex; gap: 6px; align-items: center; min-height: 32px; }
pre, textarea { font: 13px/1.45 var(--mono); background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  border-radius: 8px; padding: 12px; margin: 8px 0; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
textarea { width: 100%; min-height: 220px; resize: vertical; }
.serial { font: 600 15px/1.6 var(--mono); letter-spacing: .02em; word-spacing: .2em; background: var(--bg);
  border: 1px dashed var(--line); border-radius: 8px; padding: 12px; margin: 8px 0; word-break: break-word; }
.status { border-radius: 8px; padding: 12px; margin: 8px 0; font-weight: 600; word-break: break-word; }
.status.ok { color: var(--ok); background: var(--ok-bg); }
.status.bad { color: var(--bad); background: var(--bad-bg); }
.status.warn { color: var(--warn); background: var(--warn-bg); }
.status.info { color: var(--fg); background: var(--bg); font-weight: 400; }
.verdict { font: 700 28px/1.1 var(--sans); margin: 4px 0 8px; }
dl { display: grid; grid-template-columns: minmax(110px, max-content) 1fr; gap: 4px 12px; margin: 8px 0; font-size: .92rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: var(--mono); word-break: break-all; }
ul.env { list-style: none; padding: 0; margin: 8px 0; font-size: .92rem; }
ul.env li { padding: 2px 0; }
`;

// Plain browser JavaScript (no template literals, so it can live inside this TS string safely).
const PAGE_SCRIPT = `
(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("spike-config").textContent);
  var W = window.SimpleWebAuthnBrowser;
  var prepared = null;
  var lastAssertion = null;

  function $(id) { return document.getElementById(id); }
  function status(id, kind, text) { var el = $(id); el.className = "status " + kind; el.textContent = text; el.hidden = false; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function kv(el, pairs) {
    clear(el);
    pairs.forEach(function (p) {
      var dt = document.createElement("dt"); dt.textContent = p[0];
      var dd = document.createElement("dd"); dd.textContent = p[1] === undefined || p[1] === null ? "n/a" : String(p[1]);
      el.appendChild(dt); el.appendChild(dd);
    });
    el.hidden = false;
  }
  function errText(err) {
    if (!err) return "unknown error";
    var code = err.code ? err.code + ": " : (err.name && err.name !== "Error" ? err.name + ": " : "");
    return code + (err.message || String(err));
  }
  function serial(hex) { return hex.replace(/(.{4})/g, "$1 ").trim(); }
  function b64url(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  async function sha256B64url(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return b64url(new Uint8Array(buf));
  }
  async function call(method, path, body) {
    var init = { method: method, headers: {}, credentials: "same-origin" };
    if (method === "POST") { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body || {}); }
    var res = await fetch(cfg.basePath + path, init);
    var data = null;
    try { data = await res.json(); } catch (_e) { data = null; }
    if (!res.ok) {
      var e = new Error((data && (data.message || data.error)) || ("HTTP " + res.status));
      e.data = data;
      throw e;
    }
    return data;
  }
  function flagText(f) {
    if (!f) return "n/a";
    return "UP=" + (f.up ? "1" : "0") + " UV=" + (f.uv ? "1" : "0") + " BE=" + (f.be ? "1" : "0") + " BS=" + (f.bs ? "1" : "0");
  }

  async function checkEnvironment() {
    var list = $("env");
    function add(ok, text) {
      var li = document.createElement("li");
      li.textContent = (ok === true ? "OK  " : ok === false ? "NO  " : "--  ") + text;
      list.appendChild(li);
    }
    add(window.isSecureContext, "Secure context (HTTPS or localhost): " + location.origin);
    add(!!W, "@simplewebauthn/browser " + cfg.libVersion + " loaded from the pinned CDN URL");
    var host = location.hostname;
    var rpOk = host === cfg.rpID || host.slice(-(cfg.rpID.length + 1)) === "." + cfg.rpID;
    add(rpOk, "RP ID '" + cfg.rpID + "' matches this host '" + host + "'");
    var originOk = cfg.expectedOrigins.indexOf(location.origin) !== -1;
    add(originOk, "Server expects this origin (" + cfg.expectedOrigins.join(", ") + ")");
    if (!W) { status("env-status", "bad", "Could not load the WebAuthn helper library (CDN blocked or SRI mismatch)."); return; }
    add(W.browserSupportsWebAuthn(), "WebAuthn API available");
    var platform = null;
    try { platform = await W.platformAuthenticatorIsAvailable(); } catch (_e) { platform = null; }
    add(platform, "Platform authenticator (Windows Hello / Touch ID / phone screen lock) available");
    if (!window.isSecureContext) status("env-status", "bad", "WebAuthn needs a secure context. Use http://localhost:<port> locally or the HTTPS Render URL. A LAN IP over http will not work.");
    else if (!rpOk) status("env-status", "bad", "Set WEBAUTHN_RP_ID to '" + host + "' (or a registrable parent of it) and restart, otherwise the browser rejects every ceremony.");
    else if (!originOk) status("env-status", "warn", "This origin is not in the server's expected list. Set GATEWAY_BASE_URL (or APP_BASE_URL) to " + location.origin + " and restart.");
  }

  async function register(kind) {
    status("register-status", "info", "Waiting for the authenticator...");
    try {
      var options = await call("POST", "/register/options", { authenticator: kind });
      var attestation = await W.startRegistration({ optionsJSON: options });
      var result = await call("POST", "/register/verify", { response: attestation });
      status("register-status", "ok", "Passkey registered and verified by the server.");
      kv($("register-details"), [
        ["credential", result.credentialId],
        ["authenticator", result.authenticatorName],
        ["AAGUID", result.aaguid],
        ["attachment", result.authenticatorAttachment],
        ["transports", (result.transports || []).join(", ") || "n/a"],
        ["device type", result.credentialDeviceType + (result.credentialBackedUp ? " (backed up)" : "")],
        ["user verified", result.userVerified],
        ["attestation", result.fmt]
      ]);
    } catch (err) {
      status("register-status", "bad", "Registration failed: " + errText(err));
    }
    refreshReport();
  }

  async function prepare() {
    var via = (document.querySelector("input[name=via]:checked") || {}).value || "any";
    $("sign").disabled = true;
    prepared = null;
    status("prepare-status", "info", "Asking the server for the canonical Writ and its hash...");
    try {
      var data = await call("POST", "/sign/options", { via: via });
      $("writ-json").textContent = JSON.stringify(data.writ, null, 2);
      $("writ-canonical").textContent = data.canonical;
      $("writ-canonical-wrap").hidden = false;
      $("serial").textContent = serial(data.hashHex);
      var local = await sha256B64url(data.canonical);
      if (local !== data.challenge || data.options.challenge !== data.challenge) {
        status("prepare-status", "bad", "The challenge is not the SHA-256 of the canonical Writ shown. Refusing to sign.");
        return;
      }
      prepared = data;
      $("sign").disabled = false;
      status("prepare-status", "ok", "This browser recomputed SHA-256(JCS(Writ)) and it equals the WebAuthn challenge: " + data.challenge);
    } catch (err) {
      status("prepare-status", "bad", "Could not prepare: " + errText(err));
    }
  }

  async function sign() {
    if (!prepared) return;
    var options = prepared.options;
    prepared = null;
    $("sign").disabled = true;
    $("tamper").disabled = true;
    status("sign-status", "info", "Waiting for the passkey (fingerprint, face, PIN or phone)...");
    try {
      var assertion = await W.startAuthentication({ optionsJSON: options });
      var result = await call("POST", "/sign/verify", { response: assertion });
      lastAssertion = assertion;
      $("sign-verdict").textContent = "PASS";
      $("sign-verdict").className = "verdict status ok";
      status("sign-status", "ok", "Server verified the passkey signature over the Writ hash.");
      kv($("sign-details"), [
        ["verified hash", result.hashHex],
        ["challenge", result.challenge],
        ["flags", flagText(result.flags)],
        ["counter", result.counter],
        ["attachment", result.authenticatorAttachment],
        ["transports", (result.transports || []).join(", ") || "n/a"],
        ["authenticator", result.authenticatorName],
        ["device type", result.credentialDeviceType + (result.credentialBackedUp ? " (backed up)" : "")],
        ["origin", result.origin],
        ["RP ID", result.rpID],
        ["credential", result.credentialId]
      ]);
      $("tamper").disabled = false;
    } catch (err) {
      $("sign-verdict").textContent = "FAIL";
      $("sign-verdict").className = "verdict status bad";
      status("sign-status", "bad", "Signing failed: " + errText(err));
    }
    $("sign-verdict").hidden = false;
    refreshReport();
  }

  async function tamper() {
    if (!lastAssertion) return;
    status("tamper-status", "info", "Re-verifying the same assertion against a modified Writ...");
    try {
      var r = await call("POST", "/sign/verify-tampered", { response: lastAssertion });
      $("tamper-verdict").textContent = r.ok ? "FAIL (as expected)" : "UNEXPECTED RESULT";
      $("tamper-verdict").className = "verdict status " + (r.ok ? "ok" : "bad");
      $("tamper-verdict").hidden = false;
      status("tamper-status", r.ok ? "ok" : "bad", r.ok
        ? "The signature only verifies for the Writ that was actually signed."
        : "Tamper check did not behave as expected; see details.");
      kv($("tamper-details"), [
        ["change", r.tampered.change.path + ": " + r.tampered.change.from + " -> " + r.tampered.change.to],
        ["tampered hash", r.tampered.hashHex],
        ["tampered result", r.tampered.verified ? "VERIFIED (bad)" : "REJECTED: " + r.tampered.error],
        ["forged clientDataJSON", r.forged ? (r.forged.verified ? "VERIFIED (bad)" : "REJECTED: " + r.forged.error) : "n/a"],
        ["original hash", r.control.hashHex],
        ["control result", r.control.verified ? "VERIFIED (same assertion, original Writ)" : "REJECTED: " + r.control.error]
      ]);
    } catch (err) {
      status("tamper-status", "bad", "Tamper check failed to run: " + errText(err));
    }
    refreshReport();
  }

  async function refreshReport() {
    try {
      var r = await call("GET", "/report");
      $("report-verdict").textContent = r.verdict;
      $("report-verdict").className = "verdict status " + (r.verdict === "PASS" ? "ok" : "warn");
      $("report-missing").textContent = r.missing.length ? "Still missing: " + r.missing.join("; ") : "All S6 conditions met.";
      $("report-markdown").value = r.markdown;
    } catch (err) {
      $("report-missing").textContent = "Could not load the report: " + errText(err);
    }
  }

  function copyReport() {
    var text = $("report-markdown").value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { $("copy").textContent = "Copied"; }, function () { $("report-markdown").select(); });
    } else {
      $("report-markdown").select();
    }
  }

  $("writ-json").textContent = JSON.stringify(cfg.sampleWrit, null, 2);
  $("serial").textContent = serial(cfg.sampleHashHex) + "  (before nonce)";
  $("tamper-desc").textContent = cfg.tamper.path + " " + cfg.tamper.from + " -> " + cfg.tamper.to;
  document.querySelectorAll("[data-register]").forEach(function (b) {
    b.addEventListener("click", function () { register(b.getAttribute("data-register")); });
  });
  $("prepare").addEventListener("click", prepare);
  $("sign").addEventListener("click", sign);
  $("tamper").addEventListener("click", tamper);
  $("refresh").addEventListener("click", refreshReport);
  $("copy").addEventListener("click", copyReport);
  checkEnvironment();
  refreshReport();
})();
`;

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

const SCRIPT_HASH = cspHash(PAGE_SCRIPT);
const STYLE_HASH = cspHash(PAGE_STYLE);

/** CSP for the spike page: only our inline script/style (by hash), the pinned CDN file, same-origin fetches. */
export const PASSKEY_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${SCRIPT_HASH} ${SIMPLEWEBAUTHN_BROWSER_CDN.url}`,
  `style-src ${STYLE_HASH}`,
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Serializes data for a <script type="application/json"> block without letting it close the tag. */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPasskeyPage(config: PasskeyPageConfig): string {
  const data = { ...config, libVersion: SIMPLEWEBAUTHN_BROWSER_CDN.version };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Spike S6: passkey over a Writ hash</title>
<style>${PAGE_STYLE}</style>
<script src="${SIMPLEWEBAUTHN_BROWSER_CDN.url}" integrity="${SIMPLEWEBAUTHN_BROWSER_CDN.integrity}" crossorigin="anonymous"></script>
<script type="application/json" id="spike-config">${jsonForHtml(data)}</script>
</head>
<body>
<main>
  <span class="label">Spike S6 &middot; not part of the product</span>
  <h1>Passkey signs a Writ hash</h1>
  <p class="muted">Engineering spike (plan &sect;17 S6). Passkeys are kept in server memory only and are forgotten on restart.
    RP: <strong>${escapeHtml(config.rpName)}</strong> &middot; RP ID <code>${escapeHtml(config.rpID)}</code></p>

  <section aria-labelledby="h-env">
    <h2 id="h-env">0. Environment</h2>
    <ul class="env" id="env"></ul>
    <div id="env-status" class="status" hidden></div>
  </section>

  <section aria-labelledby="h-reg">
    <h2 id="h-reg">1. Create a passkey</h2>
    <p class="muted">User verification is required (fingerprint, face or device PIN). For the phone run, pick
      &ldquo;phone (QR)&rdquo;, scan the QR code with the phone camera and keep Bluetooth on for both devices.
      On the deployed HTTPS URL you can also open this page directly on the phone and use &ldquo;this device&rdquo;.</p>
    <div class="row">
      <button type="button" data-register="platform">Create on this device</button>
      <button type="button" data-register="phone" class="secondary">Create on a phone (QR)</button>
      <button type="button" data-register="any" class="secondary">Let the browser choose</button>
    </div>
    <div id="register-status" class="status" hidden></div>
    <dl id="register-details" hidden></dl>
  </section>

  <section aria-labelledby="h-writ">
    <h2 id="h-writ">2. The Writ and its serial number</h2>
    <p class="muted">Sample hero Writ (spike-only shape; money in minor units as strings). The serial number is
      SHA-256 over the RFC 8785 canonical JSON. Preparing adds a fresh server nonce so every signature is unique.</p>
    <pre id="writ-json"></pre>
    <div id="writ-canonical-wrap" hidden>
      <p class="muted">Canonical bytes that are hashed (JCS):</p>
      <pre id="writ-canonical"></pre>
    </div>
    <p class="muted">Serial number (SHA-256, hex):</p>
    <div class="serial" id="serial"></div>
    <fieldset>
      <legend>Sign with</legend>
      <label><input type="radio" name="via" value="any" checked> any passkey</label>
      <label><input type="radio" name="via" value="this-device"> this device</label>
      <label><input type="radio" name="via" value="phone"> a phone (QR)</label>
    </fieldset>
    <div class="row"><button type="button" id="prepare">Prepare Writ for signing</button></div>
    <div id="prepare-status" class="status" hidden></div>
  </section>

  <section aria-labelledby="h-sign">
    <h2 id="h-sign">3. Sign the hash with the passkey</h2>
    <p class="muted">The WebAuthn challenge is exactly the 32 hash bytes. The server re-derives the hash from its own copy of the Writ and verifies the assertion.</p>
    <div class="row"><button type="button" id="sign" disabled>Sign with passkey</button></div>
    <div id="sign-verdict" class="verdict" hidden></div>
    <div id="sign-status" class="status" hidden></div>
    <dl id="sign-details" hidden></dl>
  </section>

  <section aria-labelledby="h-tamper">
    <h2 id="h-tamper">4. Tamper test</h2>
    <p class="muted">Verify the same assertion against a modified Writ (<span id="tamper-desc"></span>). It must fail, also when the
      challenge inside clientDataJSON is rewritten to the modified hash; the unmodified Writ must still verify.</p>
    <div class="row"><button type="button" id="tamper" class="secondary" disabled>Verify against a tampered Writ</button></div>
    <div id="tamper-verdict" class="verdict" hidden></div>
    <div id="tamper-status" class="status" hidden></div>
    <dl id="tamper-details" hidden></dl>
  </section>

  <section aria-labelledby="h-report">
    <h2 id="h-report">5. Result for docs/SPIKES.md</h2>
    <div id="report-verdict" class="verdict status warn">...</div>
    <p id="report-missing" class="muted"></p>
    <textarea id="report-markdown" readonly aria-label="Markdown block for docs/SPIKES.md"></textarea>
    <div class="row">
      <button type="button" id="copy">Copy markdown</button>
      <button type="button" id="refresh" class="secondary">Refresh</button>
    </div>
  </section>
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

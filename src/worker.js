/**
 * het68 spectral — Cloudflare Worker.
 *
 * Serves the built analyzer from Workers assets behind Basic Auth, and sets the two
 * headers the application cannot run without.
 *
 * Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy are what make
 * SharedArrayBuffer available, and the live capture ring depends on it: without shared
 * memory every audio block has to be copied between the capture callback, the ring and
 * the worker, which at six channels and 48 kHz is a copy the browser cannot keep up
 * with for long. The cost of require-corp is that every subresource must opt in, which
 * is why the fonts are self-hosted rather than pulled from Google — a cross-origin font
 * simply does not load under this policy.
 *
 * Basic Auth is on from the first deployment. The analyzer contains the detection
 * algorithm and the signature library, and neither is meant to be public while it is
 * being developed.
 */

const COOP_COEP = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // Together with require-corp this lets same-origin subresources load; without it a
  // number of asset types are blocked even from our own origin.
  "Cross-Origin-Resource-Policy": "same-origin",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // No frames, no plugins, and nothing loaded from anywhere else. The application is
  // entirely self-contained: WebAssembly is embedded in the bundle and the fonts are
  // served from this origin.
  "Content-Security-Policy": [
    "default-src 'self'",
    // blob: is for the capture AudioWorklet, which is compiled from a source string so
    // that the same code loads from the dev server, from here and from Electron. Only
    // same-origin script can mint a blob URL, so this does not admit anything external.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' blob: data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  // Length is compared first and leaks only the length, which is not the secret.
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="het68 spectral", charset="UTF-8"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function misconfigured() {
  return new Response(
    "This deployment has no credentials configured. Set the BASIC_AUTH_USER and BASIC_AUTH_PASS secrets.",
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}

function checkBasicAuth(request, user, pass) {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    return (
      timingSafeEqual(decoded.slice(0, colon), user) &&
      timingSafeEqual(decoded.slice(colon + 1), pass)
    );
  } catch {
    return false;
  }
}

function withHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...COOP_COEP, ...SECURITY_HEADERS, ...extra })) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A liveness probe that does not require the password, so uptime monitoring does
    // not need the credentials.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "het68-spectral" }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    /*
     * A missing secret fails closed. The tempting alternative, a built-in dev/dev,
     * means one forgotten "wrangler secret put" publishes the analyzer with a password
     * that is written in this file, and nothing about the running site would look
     * wrong.
     */
    const user = env.BASIC_AUTH_USER;
    const pass = env.BASIC_AUTH_PASS;
    if (!user || !pass) return misconfigured();
    if (!checkBasicAuth(request, user, pass)) return unauthorized();

    const asset = await env.ASSETS.fetch(request);

    // The build is content-hashed, so assets can be cached hard while the entry
    // document must not be, or a deployment would not be picked up.
    const isDocument =
      asset.headers.get("Content-Type")?.includes("text/html") ||
      url.pathname === "/" ||
      url.pathname.endsWith(".html");
    const isBuildInfo = url.pathname.endsWith("build-info.json");

    return withHeaders(asset, {
      "Cache-Control":
        isDocument || isBuildInfo
          ? "no-store"
          : "public, max-age=31536000, immutable",
    });
  },
};

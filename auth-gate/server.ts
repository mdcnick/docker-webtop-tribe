// Auth gate: Clerk session verification + HTTP/WebSocket reverse proxy.
//
// Two modes:
//   1. SECURED (default) — Clerk keys provided. Every request verified.
//   2. OPEN — no Clerk keys. All requests pass through. Use for local
//      agent desktop where auth is handled upstream (e.g. Tribe Chat UI).
//
// Terminal routes (/terminal/*) are proxied to the pty-server running
// inside the webtop container instead of Selkies.

import { createClerkClient, type SignedInAuthObject } from "@clerk/backend";

const PORT = Number(Bun.env.PORT ?? 8080);
const UPSTREAM = Bun.env.UPSTREAM ?? "http://webtop:3001";
const PTY_HTTP = Bun.env.PTY_HTTP ?? "http://webtop:8081";
const PTY_WS = Bun.env.PTY_WS ?? "ws://webtop:8082";

// Force http -> https redirect based on X-Forwarded-Proto. Enable in
// production so that any path that reaches the gate over plain http
// (misconfigured LB, direct container exposure) is bounced to https.
// Leave off for local dev where there's no TLS terminator.
const FORCE_HTTPS = Bun.env.FORCE_HTTPS === "true";
const CLERK_SECRET_KEY = Bun.env.CLERK_SECRET_KEY;
const CLERK_PUBLISHABLE_KEY = Bun.env.CLERK_PUBLISHABLE_KEY;
const PUBLIC_URL = Bun.env.PUBLIC_URL ?? "http://localhost";
const ALLOWED_EMAILS = (Bun.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_USER_IDS = (Bun.env.ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// If Clerk keys are missing, run in OPEN mode — no auth required.
const OPEN_MODE = !CLERK_SECRET_KEY || !CLERK_PUBLISHABLE_KEY;

let clerk: ReturnType<typeof createClerkClient> | null = null;

if (!OPEN_MODE) {
  clerk = createClerkClient({
    secretKey: CLERK_SECRET_KEY,
    publishableKey: CLERK_PUBLISHABLE_KEY,
  });
} else {
  console.warn("[auth-gate] OPEN MODE — no Clerk keys configured. All requests pass through.");
}

const upstreamUrl = new URL(UPSTREAM);
const upstreamWsUrl = `ws://${upstreamUrl.host}`;
const ptyHttpUrl = new URL(PTY_HTTP);
const ptyWsUrl = new URL(PTY_WS);

// Authorize the authenticated user against the allow-lists. An empty
// allow-list means "any signed-in user is allowed" — tighten this in
// production by setting ALLOWED_EMAILS or ALLOWED_USER_IDS.
async function isAuthorized(auth: SignedInAuthObject): Promise<boolean> {
  if (!ALLOWED_EMAILS.length && !ALLOWED_USER_IDS.length) return true;
  if (ALLOWED_USER_IDS.includes(auth.userId)) return true;
  if (ALLOWED_EMAILS.length) {
    const user = await clerk!.users.getUser(auth.userId);
    const emails = user.emailAddresses.map((e) =>
      e.emailAddress.toLowerCase(),
    );
    if (emails.some((e) => ALLOWED_EMAILS.includes(e))) return true;
  }
  return false;
}

async function verify(req: Request): Promise<SignedInAuthObject | null> {
  if (OPEN_MODE) {
    // Return a fake auth object so downstream code doesn't need branching.
    return { userId: "anonymous" } as SignedInAuthObject;
  }
  try {
    const res = await clerk!.authenticateRequest(req, {
      secretKey: CLERK_SECRET_KEY,
      publishableKey: CLERK_PUBLISHABLE_KEY,
    });
    if (!res.isSignedIn) return null;
    const auth = res.toAuth();
    if (!(await isAuthorized(auth))) return null;
    return auth;
  } catch (err) {
    console.error("clerk verify failed:", (err as Error).message);
    return null;
  }
}

// Minimal sign-in page. Clerk's JS SDK renders the full <SignIn/> widget
// client-side — we just host the shell.
function signInPage(): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{height:100%;margin:0;background:#0b0b0f;color:#eee;font-family:system-ui,sans-serif}
  body{display:grid;place-items:center}
  #clerk{min-width:360px}
</style>
</head><body>
<div id="clerk"></div>
<script async crossorigin="anonymous"
  data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}"
  src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
  type="text/javascript"></script>
<script>
  window.addEventListener('load', async () => {
    while (!window.Clerk) await new Promise(r => setTimeout(r, 50));
    await Clerk.load();
    if (Clerk.user) { window.location.replace('/'); return; }
    Clerk.mountSignIn(document.getElementById('clerk'), {
      afterSignInUrl: '/',
      afterSignUpUrl: '/',
    });
  });
</script>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);

    // http -> https redirect (production only). Trust X-Forwarded-Proto
    // because caddy/any reasonable LB sets it; without a forwarder,
    // fall back to Bun's view of the scheme.
    if (FORCE_HTTPS) {
      const fwdProto = req.headers.get("x-forwarded-proto");
      const scheme = fwdProto ?? url.protocol.replace(":", "");
      if (scheme !== "https" && url.pathname !== "/healthz") {
        const host = req.headers.get("x-forwarded-host") ?? url.host;
        return new Response(null, {
          status: 308,
          headers: { location: `https://${host}${url.pathname}${url.search}` },
        });
      }
    }

    // Public routes: sign-in page and health check.
    // In OPEN mode the sign-in page still exists but nothing redirects to it.
    if (url.pathname === "/auth/sign-in") return signInPage();
    if (url.pathname === "/healthz") return new Response("ok");

    const auth = await verify(req);
    if (!auth) {
      // WebSocket handshake: reject with 401 instead of redirecting,
      // browsers don't follow redirects during a WS upgrade.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "/auth/sign-in" },
      });
    }

    // Terminal WebSocket — proxy to pty-server WS port.
    if (url.pathname.startsWith("/terminal/ws") || url.pathname.startsWith("/terminal/lock")) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const target = ptyWsUrl.origin + url.pathname + url.search;
        if (server.upgrade(req, { data: { target, userId: auth.userId } })) {
          return;
        }
        return new Response("upgrade failed", { status: 500 });
      }
    }

    // Terminal HTTP API — proxy to pty-server HTTP port.
    if (url.pathname.startsWith("/terminal/exec") || url.pathname.startsWith("/terminal/resize")) {
      const proxied = new Request(
        ptyHttpUrl.origin + url.pathname.replace("/terminal", "") + url.search,
        {
          method: req.method,
          headers: req.headers,
          body: req.body,
          // @ts-expect-error Bun supports duplex:'half' for streaming bodies
          duplex: "half",
          redirect: "manual",
        },
      );
      proxied.headers.set("x-forwarded-user", auth.userId);
      try {
        return await fetch(proxied);
      } catch (err) {
        console.error("pty upstream fetch failed", err);
        return new Response("bad gateway", { status: 502 });
      }
    }

    // WebSocket upgrade: hand off to Bun's WS handler with the target
    // upstream URL stashed in ws.data so open() can dial it.
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const target = upstreamWsUrl + url.pathname + url.search;
      if (server.upgrade(req, { data: { target, userId: auth.userId } })) {
        return;
      }
      return new Response("upgrade failed", { status: 500 });
    }

    // Plain HTTP proxy. Rewrite the URL onto the upstream and forward
    // the body/headers verbatim.
    const proxied = new Request(
      upstreamUrl.origin + url.pathname + url.search,
      {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // @ts-expect-error Bun supports duplex:'half' for streaming bodies
        duplex: "half",
        redirect: "manual",
      },
    );
    proxied.headers.set("x-forwarded-user", auth.userId);
    proxied.headers.set("x-forwarded-host", url.host);
    proxied.headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

    try {
      return await fetch(proxied);
    } catch (err) {
      console.error("upstream fetch failed", err);
      return new Response("bad gateway", { status: 502 });
    }
  },

  websocket: {
    // Open a client-side WS to the upstream and pipe messages both ways.
    // We stash the upstream socket on the server socket's data so the
    // message/close handlers can reach it.
    open(ws) {
      const { target } = ws.data as { target: string; userId: string };
      const upstream = new WebSocket(target);
      (ws.data as any).upstream = upstream;
      const outbound: (string | ArrayBufferLike)[] = [];
      (ws.data as any).outbound = outbound;

      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const msg of outbound) upstream.send(msg as any);
        outbound.length = 0;
      };
      upstream.onmessage = (ev) => {
        ws.send(ev.data as any);
      };
      upstream.onclose = () => ws.close();
      upstream.onerror = (e) => {
        console.error("upstream ws error", e);
        ws.close();
      };
    },
    message(ws, message) {
      const upstream = (ws.data as any).upstream as WebSocket | undefined;
      if (!upstream) return;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message as any);
      } else {
        (ws.data as any).outbound.push(message);
      }
    },
    close(ws) {
      const upstream = (ws.data as any).upstream as WebSocket | undefined;
      upstream?.close();
    },
  },
});

console.log(
  `auth-gate listening on :${server.port} -> ${UPSTREAM} (${OPEN_MODE ? "OPEN MODE — no auth" : ALLOWED_EMAILS.length || ALLOWED_USER_IDS.length ? "allowlist" : "any signed-in user"})`,
);

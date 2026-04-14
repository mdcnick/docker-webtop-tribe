# Architecture

**Analysis Date:** 2026-04-13

## Pattern Overview

**Overall:** Three-tier containerized deployment — TLS terminator -> authenticating reverse proxy -> application container. The application itself (LinuxServer.io webtop) is a single-container s6-overlay-orchestrated XFCE desktop streamed via Selkies, but it is no longer exposed directly; authentication and TLS are enforced by sidecar containers composed together on a private network.

**Key Characteristics:**
- Defense in depth: webtop binds only to the internal compose network, never a host port. Only Caddy publishes :80/:443.
- Auth is external to the app: Clerk session verification happens in a standalone Bun service, not inside webtop.
- Hermes (Python agent) is built in an isolated Alpine builder stage and COPYed into the final image so no rust/cargo/build-base toolchain ships in production.
- s6-overlay boots the webtop container; a new `init-enterprise` oneshot runs after `init-adduser` to apply enterprise user customization (GECOS, shell, groups, sudo) based on env vars.
- Rootless-podman compatible: `STOPSIGNAL SIGRTMIN+3` gives s6 a graceful shutdown signal, and the podman examples use the default userns with a named volume (LSIO images must boot as uid 0 inside the container, so `--userns=keep-id` is intentionally NOT used).

## Runtime Topology

```
              Internet
                 |
                 v
        +-----------------+
        |  Caddy :80/:443 |   docker.io/caddy:2-alpine
        |  TLS + HSTS     |   examples/deploy/Caddyfile
        +--------+--------+
                 | reverse_proxy (HTTP, edge network)
                 | + X-Forwarded-Proto/Host, X-Real-IP
                 v
        +-----------------+
        |  auth-gate:8080 |   localhost/webtop-auth-gate (Bun 1)
        |  Clerk verify   |   auth-gate/server.ts
        |  HTTP + WS proxy|
        +--------+--------+
                 | http://webtop:3001  (edge network, internal)
                 | ws://webtop:3001    (Selkies streaming)
                 v
        +-----------------+
        |  webtop :3001   |   localhost/webtop-tribe
        |  s6-overlay     |   ghcr.io/linuxserver/baseimage-selkies:alpine323
        |  XFCE + Selkies |
        +-----------------+
```

Compose definition: `examples/deploy/compose.yml`. All three services share the `edge` bridge network. Only Caddy publishes host ports.

## Layers

**TLS Terminator (Caddy):**
- Purpose: Handle Let's Encrypt, enforce HSTS, terminate TLS, upgrade WebSockets.
- Location: `examples/deploy/Caddyfile`, `examples/deploy/compose.yml` (caddy service).
- Sets `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, strips `Server`.
- `reverse_proxy auth-gate:8080` with `header_up X-Real-IP {remote_host}`, `X-Forwarded-Proto {scheme}`, `X-Forwarded-Host {host}`. Caddy handles the WS `Upgrade` header automatically via `reverse_proxy`.
- Persists ACME state in the `caddy-data` and `caddy-config` named volumes.

**Auth Gate (Bun):**
- Purpose: Verify every HTTP request and WebSocket handshake against Clerk; enforce allow-lists; proxy to webtop.
- Location: `auth-gate/server.ts`, `auth-gate/Dockerfile`, `auth-gate/package.json`.
- Runtime: Bun 1 on Alpine, built via multi-stage `bun:1-alpine` Dockerfile.
- Depends on: `@clerk/backend` for `clerk.authenticateRequest()` and user lookups.
- Used by: Caddy (upstream). Exposes no host port.
- Config (env): `PORT` (default 8080), `UPSTREAM` (default `http://webtop:3001`), `FORCE_HTTPS`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `PUBLIC_URL`, `ALLOWED_EMAILS`, `ALLOWED_USER_IDS`.
- Public routes (no auth): `GET /auth/sign-in` serves a minimal HTML shell that loads `@clerk/clerk-js@5` from jsDelivr and mounts `<SignIn/>`; `GET /healthz` returns `ok`.
- Everything else runs `verify(req)` -> `clerk.authenticateRequest` -> allow-list check (`isAuthorized`). Empty allow-lists mean "any signed-in Clerk user"; setting `ALLOWED_EMAILS` or `ALLOWED_USER_IDS` restricts access. Email checks fetch the full Clerk user record via `clerk.users.getUser(auth.userId)`.
- Unauthenticated HTTP requests get `302 -> /auth/sign-in`. Unauthenticated WebSocket upgrades get `401` (browsers won't follow redirects mid-handshake).
- `FORCE_HTTPS=true` mode inspects `X-Forwarded-Proto`; anything non-`https` (except `/healthz`) is bounced with `308` to `https://{X-Forwarded-Host}{path}`. Falls back to `url.protocol` when no forwarder is present, so bare-metal dev without TLS works with `FORCE_HTTPS=false`.
- HTTP proxy: constructs a new `Request` against `upstreamUrl.origin + pathname + search`, forwards `method`/`headers`/`body` with `duplex: "half"` for streaming, adds `x-forwarded-user: auth.userId`, `x-forwarded-host`, `x-forwarded-proto`, uses `redirect: "manual"`.
- WebSocket proxy: on `upgrade`, `server.upgrade(req, { data: { target, userId } })` stashes the upstream ws URL in `ws.data`. In `websocket.open()`, the gate dials `new WebSocket(target)` with `binaryType = "arraybuffer"`, buffers outbound frames in `ws.data.outbound` until `upstream.onopen` flushes them, then pipes `upstream.onmessage -> ws.send` in both directions. `close`/`error` on either side tears down the other. This is what makes Selkies streaming work through the gate.

**Application (webtop):**
- Purpose: Alpine XFCE desktop environment streamed over Selkies.
- Location: `Dockerfile`, `Dockerfile.aarch64`, `root/` overlay.
- Base: `ghcr.io/linuxserver/baseimage-selkies:alpine323`.
- Exposes `3001` internally only. `VOLUME /config`. `STOPSIGNAL SIGRTMIN+3`.
- Healthcheck: `wget -qO- http://localhost:3001/` every 30s (start period 30s, 3 retries).
- Build knobs (ARG): `EXTRA_PACKAGES`, `REMOVE_PACKAGES`, `INCLUDE_CHROMIUM` (default `true`), `INSTALL_HERMES` (default `false`), `HERMES_REF` (default `v2026.4.13`).

## Build Pipeline

**Multi-stage Dockerfile (`Dockerfile`):**

Stage 1 — `hermes-builder` (`alpine:3.23`):
- Only does real work when `INSTALL_HERMES=true`.
- Installs `python3 py3-pip git build-base python3-dev libffi-dev openssl-dev rust cargo`.
- Creates `/opt/hermes` venv and `pip install`s `git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}`.
- Otherwise creates an empty `/opt/hermes` so the COPY in stage 2 is a no-op.

Stage 2 — final image (`baseimage-selkies:alpine323`):
- Installs XFCE stack (`xfce4`, `xfce4-terminal`, `thunar`, `mousepad`, `ristretto`, `adw-gtk3`, `adwaita-xfce-icon-theme`), optionally `chromium`, plus `${EXTRA_PACKAGES}`; removes `${REMOVE_PACKAGES}` if set.
- When hermes is enabled, installs runtime-only deps (`python3 libffi openssl libstdc++ git`) — no toolchain.
- `COPY --from=hermes-builder /opt/hermes /opt/hermes` and symlinks `/opt/hermes/bin/hermes` -> `/usr/local/bin/hermes` if present.
- Moves `/usr/bin/thunar` to `/usr/bin/thunar-real` so the `root/` overlay can ship a wrapper.
- Removes `xfce4-power-manager` and `xscreensaver` autostart entries and the power-manager panel plugin.
- Replaces `/usr/share/selkies/www/icon.png` with the webtop logo.
- `COPY /root /` overlays s6 service definitions, XFCE defaults, wrapper scripts, and autostart entries.

## s6-overlay Boot

The LSIO base image boots via s6-overlay. This repo adds one new oneshot service:

**`init-enterprise`** (`root/etc/s6-overlay/s6-rc.d/init-enterprise/`):
- Type: `oneshot` (`type` file).
- Dependencies: `init-adduser` (so the `abc` user exists first) — declared via `dependencies.d/init-adduser`.
- Registered in the `user` bundle via `root/etc/s6-overlay/s6-rc.d/user/contents.d/init-enterprise`.
- `run` script mutates the `abc` account based on env vars: GECOS (full name), login shell, supplementary groups, sudoers entry.

The existing `startwm.sh` / `startwm_wayland.sh` under `root/defaults/` launch XFCE as `abc` under Selkies. XFCE configuration (panel, desktop, xfwm4, xsettings) ships via `root/defaults/xfce/*.xml`.

## Data Flow

**Interactive session (happy path):**

1. User hits `https://{DOMAIN}`.
2. Caddy accepts TLS, adds `X-Forwarded-*`, `reverse_proxy`s to `auth-gate:8080`.
3. Bun gate reads `__session` cookie via `clerk.authenticateRequest` -> `SignedInAuthObject`.
4. `isAuthorized` checks `ALLOWED_USER_IDS` / `ALLOWED_EMAILS` (fetching the Clerk user record for email lookup if needed).
5. Bun rewrites the request onto `http://webtop:3001/...`, adds `x-forwarded-user`, forwards with streaming body.
6. Selkies serves the desktop HTML/JS. The browser then opens a WebSocket to the same origin.
7. Caddy upgrades, Bun runs `verify` again on the upgrade request, `server.upgrade` stashes `{ target: ws://webtop:3001/..., userId }` in `ws.data`.
8. Bun opens a client WS to webtop, flushes any buffered frames on `upstream.onopen`, then pipes frames bidirectionally for the lifetime of the session.

**Unauthenticated request:**

1. `verify(req)` returns `null` (no cookie, invalid cookie, or allow-list rejection).
2. HTTP: `302 Location: /auth/sign-in`. WS handshake: `401 unauthorized`.
3. The sign-in page loads `@clerk/clerk-js@5` from jsDelivr, mounts `<SignIn/>`; Clerk sets `__session` on its own domain/cookie, then JS redirects to `/`.

**Health check:**

`GET /healthz` on the gate is public and returns `ok` (also used by the `FORCE_HTTPS` bypass). Webtop's own Docker `HEALTHCHECK` hits `http://localhost:3001/` inside the container.

## Key Abstractions

**Auth gate (`auth-gate/server.ts`):**
- `verify(req): Promise<SignedInAuthObject | null>` — single gate for all auth decisions. Swallows Clerk exceptions and treats them as "unauthenticated" so the user is bounced to sign-in rather than getting a 500.
- `isAuthorized(auth)` — allow-list policy. Short-circuits when both lists are empty.
- `signInPage()` — inlines a minimal HTML shell with the Clerk publishable key baked into a `<script data-clerk-publishable-key>` tag.
- `Bun.serve({ fetch, websocket })` — single-process HTTP + WS server; `ws.data` carries per-connection state (`upstream`, `outbound` buffer, `userId`, `target`).

**LinuxServer overlay (`root/`):**
- s6-rc service directories are the canonical extension point. Each service is a directory with `type`, `run`, and optional `dependencies.d/`.
- Desktop entries under `root/usr/share/applications/` and `root/etc/xdg/autostart/` are how apps (e.g. `hermes.desktop`) are registered in XFCE.
- Wrappers under `root/usr/bin/` (e.g. `chromium`, `chromium-browser`, `thunar`) shim the real binaries to apply sandboxing / LD_PRELOAD workarounds.

**Base image contract (`/defaults/startwm.sh`):**
- Single hook the Selkies base image uses to launch the desktop. Overriding this file is how any downstream image chooses its WM/DE. Must `exec` and stay in the foreground so s6 can supervise.

## Entry Points

**Container entry (webtop):**
- Location: LSIO base image `/init` (s6-overlay).
- Triggers: container start.
- Responsibilities: run base init services, then `init-adduser`, then `init-enterprise`, then the `user` bundle which starts Selkies + XFCE via `/defaults/startwm.sh`.

**Container entry (auth-gate):**
- Location: `auth-gate/Dockerfile` `CMD` -> `bun run server.ts`.
- Triggers: container start.
- Responsibilities: validate required env (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`), create Clerk client, start `Bun.serve` on `0.0.0.0:${PORT}`.

**Container entry (Caddy):**
- Location: `docker.io/caddy:2-alpine` default entrypoint reading `/etc/caddy/Caddyfile`.
- Triggers: container start.
- Responsibilities: ACME cert acquisition for `${DOMAIN}`, TLS termination, reverse proxy to `auth-gate:8080`.

**Host entry (systemd):**
- `examples/deploy/webtop.service` is a systemd unit that runs the compose stack against `examples/deploy/compose.yml`. Installed to `/etc/systemd/system/webtop.service` per the quickstart comment in `compose.yml`.
- Alternative: rootless podman Quadlets under `examples/webtop.container` and `examples/webtop-config.volume`.

## Error Handling

**Strategy:** Fail closed on auth, fail clearly on upstream.

**Patterns:**
- Clerk verification errors are logged (`console.error("clerk verify failed:", ...)`) and converted to `null` -> redirect, never `500`.
- Upstream HTTP failures return `502 bad gateway` with the error logged.
- Upstream WebSocket errors close the client WS (`upstream.onerror` -> `ws.close()`).
- Missing Clerk keys at boot call `process.exit(1)` so the container crash-loops rather than running unauthenticated.
- Chromium shims probe `/proc/1/status` at every launch to decide whether `--no-sandbox --test-type` is required, covering privileged and unprivileged deployments without configuration.
- xfconf seed in `startwm.sh` is guarded by a directory-existence check so a user's edits in `/config` are never overwritten on upgrade.

## Cross-Cutting Concerns

**Authentication:** Clerk `__session` cookie, verified by `@clerk/backend` in the auth-gate. Per-user allow-listing by email or Clerk user ID. Propagated to webtop as `x-forwarded-user` (informational only — webtop does not currently read it).

**TLS / HSTS:** Caddy auto-provisions Let's Encrypt certs using `LETSENCRYPT_EMAIL`. HSTS is set with a 2-year max-age and `preload` eligibility. `FORCE_HTTPS=true` in the gate is a belt-and-suspenders 308 redirect based on `X-Forwarded-Proto`, skipped only for `/healthz`.

**Supervision:** s6-overlay from the LSIO base image supervises Selkies, Xvfb/Xwayland, PulseAudio, DBus, and the XFCE session launched via `startwm.sh`. `init-enterprise` is a oneshot ordered after `init-adduser`.

**Streaming transport:** Selkies (WebRTC + WebSocket signaling) on TCP 3001, proxied end-to-end through the Bun gate's WS pipe.

**Persistence:** Single `VOLUME /config` declared in `Dockerfile`. In compose this is backed by the `webtop-config` named volume. Caddy's ACME state lives in `caddy-data` / `caddy-config` named volumes.

**Logging:** `console.log` / `console.error` in the Bun gate; s6 service logs (stdout) in webtop; Caddy access logs go to stdout by default.

**Shutdown:** `STOPSIGNAL SIGRTMIN+3` in the Dockerfile tells Docker/Podman to signal s6-overlay's graceful shutdown path. The compose file sets `stop_signal: SIGRTMIN+3` and `stop_grace_period: 30s` on the webtop service.

**Rootless podman:** The LSIO base image must boot as uid 0 inside the container (s6 drops to `abc`/PUID internally). The podman examples intentionally do NOT use `--userns=keep-id`; they rely on the default userns mapping plus a named volume for `/config` so the UID inside the container stays stable across restarts.

**Multi-arch:** Parallel `Dockerfile` and `Dockerfile.aarch64` so Jenkins (`Jenkinsfile`, `jenkins-vars.yml`) can build an arm64 variant; both consume the same `root/` overlay.

---

*Architecture analysis: 2026-04-13*

# External Integrations

**Analysis Date:** 2026-04-13

## APIs & External Services

**Authentication:**
- Clerk — session verification for the auth-gate reverse proxy
  - SDK: `@clerk/backend` ^1.15.0 (`auth-gate/package.json`)
  - Client JS: `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js` loaded by the sign-in shell page in `auth-gate/server.ts`
  - Env: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`
  - Calls used: `createClerkClient`, `clerk.authenticateRequest(req, ...)`, `clerk.users.getUser(userId)` for email allow-list resolution
  - Session cookie: `__session` (verified on every HTTP request and WebSocket upgrade)

**AI Agent (optional, baked at build time):**
- Nous Research Hermes Agent — `git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}`
  - Default ref: `v2026.4.13` (build arg `HERMES_REF`)
  - Installed into an isolated Python venv at `/opt/hermes` during the `hermes-builder` multi-stage; final image only receives the venv directory
  - Exposed as `/usr/local/bin/hermes` (symlink) when the venv is populated
  - Launched from XFCE via `root/usr/share/applications/hermes.desktop` (`xfce4-terminal --title="Hermes Agent" --command="hermes"`) and autostart entry `root/etc/xdg/autostart/hermes.desktop`

**Certificates:**
- Let's Encrypt via Caddy 2 — automatic issuance/renewal driven by the `{env.DOMAIN}` site block in `examples/deploy/Caddyfile`; ACME account email from `LETSENCRYPT_EMAIL`

**Base images (container registries):**
- `ghcr.io/linuxserver/baseimage-selkies:alpine323` (amd64) — `Dockerfile`
- `ghcr.io/linuxserver/baseimage-selkies:arm64v8-alpine323` (arm64) — `Dockerfile.aarch64`
- `docker.io/oven/bun:1-alpine` — `auth-gate/Dockerfile`
- `docker.io/caddy:2-alpine` — `examples/deploy/compose.yml`
- `alpine:3.23` — hermes-builder stage

**Upstream asset fetch at build time:**
- `https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/webtop-logo.png` — copied to `/usr/share/selkies/www/icon.png`

## Data Storage

**Databases:**
- None. The webtop container is stateless aside from `/config`.

**File Storage:**
- Local bind/named volume at `/config` (`VOLUME /config` in both Dockerfiles)
- Compose: named volume `webtop-config` (`examples/deploy/compose.yml`)
- Quadlet: `examples/webtop-config.volume` + `Volume=webtop-config.volume:/config` in `examples/webtop.container` — keeps ownership inside the userns for rootless Podman
- Caddy state: named volumes `caddy-data`, `caddy-config`

**Caching:**
- None at the app layer. Caddy handles HTTP response compression (`encode zstd gzip`).

## Authentication & Identity

**Edge auth (production deploy):**
- Clerk-backed Bun reverse proxy (`auth-gate/server.ts`)
  - Flow: Client -> Caddy `:443` (TLS) -> auth-gate `:8080` (Clerk verify) -> webtop `:3001`
  - Unauthenticated HTTP -> `302 /auth/sign-in` (serves an inline HTML shell that mounts Clerk's `<SignIn/>` via `Clerk.mountSignIn`)
  - Unauthenticated WebSocket upgrade -> `401` (browsers do not follow redirects on WS handshakes)
  - Authorization: `ALLOWED_USER_IDS` (Clerk user id match) and/or `ALLOWED_EMAILS` (resolved via `clerk.users.getUser`). Empty lists = any signed-in user
  - `FORCE_HTTPS=true` bounces any non-https request (based on `X-Forwarded-Proto`) with `308`, except `/healthz`
  - Forwarded headers injected upstream: `x-forwarded-user`, `x-forwarded-host`, `x-forwarded-proto`

**In-container auth (optional, layered):**
- Selkies built-in basic auth via `CUSTOM_USER` / `PASSWORD` env vars (LSIO base image behavior)

**User provisioning inside the container:**
- Custom s6 oneshot `root/etc/s6-overlay/s6-rc.d/init-enterprise/run` (depends on `init-adduser`, wired via `root/etc/s6-overlay/s6-rc.d/user/contents.d/init-enterprise`)
- Applies `ENTERPRISE_FULLNAME`, `ENTERPRISE_SHELL`, `ENTERPRISE_GROUPS` (creates groups by `name:gid` and adds `abc`), and `ENTERPRISE_SUDO=true` (installs `sudo` on demand, drops `/etc/sudoers.d/abc`)

## Monitoring & Observability

**Error Tracking:**
- None. `auth-gate/server.ts` logs Clerk failures and upstream fetch errors to stderr via `console.error`; operators are expected to read container logs.

**Logs:**
- stdout/stderr only; s6-overlay forwards service logs to the container stdout
- auth-gate logs a startup line with the allow-list mode (`allowlist` vs `any signed-in user`)

**Health checks:**
- Webtop image: `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://localhost:3001/` (defined in both Dockerfiles)
- auth-gate image: `HEALTHCHECK ... CMD wget -qO- http://127.0.0.1:8080/healthz` with public `/healthz` route in `server.ts` (bypasses auth and `FORCE_HTTPS`)
- Quadlet unit `examples/webtop.container` declares `HealthCmd`/`HealthInterval`/etc. so Podman drives the same probe

## CI/CD & Deployment

**Hosting (reference deploy):**
- Self-hosted VPS running systemd + Podman
- `examples/deploy/webtop.service` — `Type=oneshot`, `ExecStart=/usr/bin/podman compose up -d`, `WorkingDirectory=/opt/docker-webtop-tribe/examples/deploy`, `TimeoutStartSec=600`

**CI Pipeline:**
- Jenkins — `Jenkinsfile` driven by `jenkins-vars.yml`
  - `project_name: docker-webtop`, `release_type: stable`, `release_tag: latest`, `ls_branch: master`
  - Multiarch: `MULTIARCH=true` (amd64 + arm64, `build_armhf: false`)
  - Smoke test: `CI=true`, `CI_WEB=true`, `CI_PORT=3001`, `CI_SSL=true`, `CI_DELAY=60`, `CI_WEB_SCREENSHOT_DELAY=10`, `CI_AUTH=user:password`
  - Images published to `linuxserver/webtop`, `lsiodev/webtop`, `lspipepr/webtop`
- Bot commits observed in history for package-version bumps and templated-file refreshes

**Local/one-shot runners:**
- `examples/podman-run.sh` — rootless Podman convenience launcher
- `examples/webtop.container` + `examples/webtop-config.volume` — Podman Quadlet units (installable under `~/.config/containers/systemd/`)

## Environment Configuration

**Required env vars (canonical list: root `.env.example`):**

Build-time:
- `EXTRA_PACKAGES`, `REMOVE_PACKAGES`, `INCLUDE_CHROMIUM`, `INSTALL_HERMES`, `HERMES_REF`

Runtime (webtop):
- `PUID`, `PGID`, `UMASK`, `TZ`
- `CUSTOM_USER`, `PASSWORD` (optional Selkies basic auth)
- `ENTERPRISE_FULLNAME`, `ENTERPRISE_SHELL`, `ENTERPRISE_GROUPS`, `ENTERPRISE_SUDO`

VPS deploy:
- `DOMAIN`, `LETSENCRYPT_EMAIL`
- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- `ALLOWED_EMAILS`, `ALLOWED_USER_IDS`

auth-gate (local dev):
- `UPSTREAM`, `PORT`, `PUBLIC_URL`, `FORCE_HTTPS`

**Secrets location:**
- `.env` files on the host, never committed. Two `.env.example` templates exist:
  - Repo root `.env.example` — canonical superset covering build args, runtime, VPS deploy, and auth-gate local dev
  - `examples/deploy/.env.example` — minimal VPS-only subset intended to be copied to `examples/deploy/.env`
- No secret manager integration; Clerk keys and Let's Encrypt email are plain env vars consumed by Bun and Caddy

## Webhooks & Callbacks

**Incoming:**
- None. The only externally reachable endpoints are the Clerk sign-in shell (`/auth/sign-in`), `/healthz`, and the proxied Selkies web UI — there are no webhook receivers.

**Outgoing:**
- Clerk API calls from `auth-gate/server.ts` (`authenticateRequest`, `users.getUser`)
- Let's Encrypt ACME from Caddy during certificate issuance/renewal
- GitHub (build-time only) when `INSTALL_HERMES=true` to clone `NousResearch/hermes-agent`

---

*Integration audit: 2026-04-13*

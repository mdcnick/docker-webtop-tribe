# Technology Stack

**Analysis Date:** 2026-04-13

## Languages

**Primary:**
- Dockerfile / shell (POSIX + bash) — image definition and s6 init hooks (`Dockerfile`, `Dockerfile.aarch64`, `root/etc/s6-overlay/s6-rc.d/init-enterprise/run`, `root/defaults/startwm.sh`)
- TypeScript (ES2022, ESM) — auth-gate reverse proxy (`auth-gate/server.ts`, `auth-gate/tsconfig.json`)

**Secondary:**
- Python 3 — only as the runtime for the Hermes Agent venv at `/opt/hermes` (baked in via `Dockerfile` hermes-builder stage)
- YAML — Jenkins + deploy config (`jenkins-vars.yml`, `readme-vars.yml`, `examples/deploy/compose.yml`)
- Groovy — CI pipeline (`Jenkinsfile`)
- Caddyfile — TLS terminator config (`examples/deploy/Caddyfile`)
- systemd unit / Quadlet — host integration (`examples/webtop.container`, `examples/webtop-config.volume`, `examples/deploy/webtop.service`)

## Runtime

**Webtop container:**
- Base image: `ghcr.io/linuxserver/baseimage-selkies:alpine323` (amd64), `ghcr.io/linuxserver/baseimage-selkies:arm64v8-alpine323` (aarch64)
- Alpine 3.23 userland, s6-overlay init (`STOPSIGNAL SIGRTMIN+3` for graceful shutdown)
- Selkies WebRTC desktop streaming, exposed on TCP `3001`
- `HEALTHCHECK` every 30s via `wget http://localhost:3001/`

**Hermes builder stage:**
- `alpine:3.23` (matches final image ABI for wheel compatibility)
- Creates a Python venv at `/opt/hermes` and `pip install`s `git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}`
- Runtime-side Alpine packages installed when `INSTALL_HERMES=true`: `python3 libffi openssl libstdc++ git`
- Symlinked to `/usr/local/bin/hermes` in the final stage

**auth-gate container:**
- `docker.io/oven/bun:1-alpine` (multi-stage: `deps` + final)
- Bun 1.x as both package manager and runtime (`bun install`, `bun run server.ts`)
- Listens on `:8080`, runs as `USER bun`, healthcheck on `/healthz`

## Frameworks

**Core (image):**
- s6-overlay — process supervision and init ordering; custom oneshot at `root/etc/s6-overlay/s6-rc.d/init-enterprise/` wired into the `user` bundle via `contents.d/init-enterprise`
- XFCE 4 desktop — `xfce4`, `xfce4-terminal`, `thunar` (wrapped via `root/usr/bin/thunar`), `mousepad`, `ristretto`
- Selkies — inherited from base image, web UI assets under `/usr/share/selkies/www/`

**Core (auth-gate):**
- `@clerk/backend` ^1.15.0 — `createClerkClient`, `authenticateRequest`, `users.getUser` for session verification and allow-list enforcement
- `Bun.serve` — native HTTP + WebSocket server (no Express/Hono); WS upstream is bridged to `ws://webtop:3001` via `new WebSocket()` inside `websocket.open`

**Edge (deploy):**
- `docker.io/caddy:2-alpine` — TLS terminator with automatic Let's Encrypt, aggressive HSTS (`max-age=63072000; includeSubDomains; preload`), `reverse_proxy auth-gate:8080`

**Testing:**
- Not detected in repo. CI smoke-test is driven by LSIO's Jenkins pipeline (`CI=true`, `CI_WEB=true`, `CI_PORT=3001`, `CI_SSL=true` in `jenkins-vars.yml`); no unit-test framework for `auth-gate/`.

**Build/Dev:**
- Docker / Podman BuildKit (`# syntax=docker/dockerfile:1`, multi-stage)
- Jenkins pipeline — `Jenkinsfile` + `jenkins-vars.yml` (multiarch amd64/arm64, `build_armhf: false`)
- README generator — `readme-vars.yml` drives `README.md`

## Key Dependencies

**Critical (auth-gate, `auth-gate/package.json`):**
- `@clerk/backend` ^1.15.0 — session verification, user lookup for email allow-list
- `typescript` ^5.6.0 (dev)
- `@types/bun` latest (dev)

**Critical (image, Alpine packages in `Dockerfile` / `Dockerfile.aarch64`):**
- `xfce4`, `xfce4-terminal`, `thunar`, `mousepad`, `ristretto`
- `adw-gtk3`, `adwaita-xfce-icon-theme`
- `chromium` — conditional on `INCLUDE_CHROMIUM=true` (default); wrapper at `root/usr/bin/chromium` / `chromium-browser`
- `util-linux-misc`
- Hermes runtime (when `INSTALL_HERMES=true`): `python3 libffi openssl libstdc++ git`

**Hermes Agent:**
- `NousResearch/hermes-agent` pinned to `HERMES_REF=v2026.4.13` (overridable build arg)
- Installed into isolated venv at `/opt/hermes`; toolchain (`build-base python3-dev libffi-dev openssl-dev rust cargo`) lives only in the builder stage so it never ships in the final image

## Configuration

**Build-time args (both Dockerfiles):**
- `EXTRA_PACKAGES` — space-separated extra Alpine packages to bake in
- `REMOVE_PACKAGES` — space-separated packages to `apk del` after install
- `INCLUDE_CHROMIUM` — `true`/`false`, gates the `chromium` apk
- `INSTALL_HERMES` — `true`/`false`, gates the hermes-builder stage + runtime deps
- `HERMES_REF` — git ref for `hermes-agent` (default `v2026.4.13`)
- `BUILD_DATE`, `VERSION`, `XFCE_VERSION` — LSIO label metadata

**Runtime env (documented in root `.env.example`):**
- LSIO standard: `PUID`, `PGID`, `UMASK`, `TZ`
- Optional Selkies basic auth: `CUSTOM_USER`, `PASSWORD`
- Enterprise init hook: `ENTERPRISE_FULLNAME`, `ENTERPRISE_SHELL`, `ENTERPRISE_GROUPS` (space-separated `name:gid`), `ENTERPRISE_SUDO`
- Deploy: `DOMAIN`, `LETSENCRYPT_EMAIL`
- Clerk: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ALLOWED_EMAILS`, `ALLOWED_USER_IDS`
- auth-gate: `PORT` (default 8080), `UPSTREAM` (default `http://webtop:3001`), `PUBLIC_URL`, `FORCE_HTTPS`

**Build files:**
- `Dockerfile` (amd64), `Dockerfile.aarch64` (arm64) — kept in lockstep, only base image differs
- `auth-gate/Dockerfile`, `auth-gate/tsconfig.json`, `auth-gate/.dockerignore`
- `examples/deploy/compose.yml`, `examples/deploy/Caddyfile`
- `Jenkinsfile`, `jenkins-vars.yml`

## Platform Requirements

**Development:**
- Docker or Podman >= 4.4 (for Quadlet `.container` / `.volume` units)
- Bun 1.x for local `auth-gate` dev (`cd auth-gate && bun run dev`)
- Modern browser with WebRTC for the Selkies client

**Production:**
- Linux VPS with systemd and Podman (or Docker) — `examples/deploy/webtop.service` calls `podman compose up -d`
- Public DNS A/AAAA pointing at the host before first start (Caddy provisions Let's Encrypt certs on boot)
- Ports `80` and `443` reachable from the internet; webtop and auth-gate do **not** bind host ports
- `shm_size: 1g` and `seccomp=unconfined` for Chromium
- Rootless Podman: default userns only — never `--userns=keep-id` (breaks LSIO `init-adduser`, `init-nginx`, `init-selkies`)

---

*Stack analysis: 2026-04-13*

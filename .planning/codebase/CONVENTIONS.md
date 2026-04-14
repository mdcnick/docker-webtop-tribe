# Coding Conventions

**Analysis Date:** 2026-04-13

This repository started as a LinuxServer.io (LSIO) webtop fork and has grown to include a Bun/TypeScript auth sidecar and a Caddy-fronted compose deployment. It now spans **three distinct style domains**. Match the conventions of the domain you are editing — do not cross-pollinate (no TypeScript idioms in shell scripts, no bash idioms in Caddyfile, no `docker-compose.yml` literals where `${VAR}` substitution is expected).

## Domain map

| Domain | Paths | Style source |
|---|---|---|
| 1. LSIO base image | `Dockerfile`, `Dockerfile.aarch64`, `root/`, `Jenkinsfile`, `jenkins-vars.yml`, `readme-vars.yml`, `package_versions.txt` | Upstream LSIO templates |
| 2. auth-gate (Bun/TS) | `auth-gate/server.ts`, `auth-gate/package.json`, `auth-gate/tsconfig.json`, `auth-gate/Dockerfile`, `auth-gate/bun.lock*` | Bun + strict TS ESM |
| 3. Deploy stack | `examples/deploy/compose.yml`, `examples/deploy/Caddyfile`, `examples/deploy/.env.example`, `examples/podman-run.sh` | Compose spec + Caddy v2 |

---

## Domain 1: LSIO Base Image (Dockerfile + shell)

### Repository Layout Conventions

**Top-level files (LSIO standard, do not rename):**
- `Dockerfile` - x86_64 build
- `Dockerfile.aarch64` - arm64 build (kept in lockstep with `Dockerfile`)
- `Jenkinsfile` - LSIO shared pipeline (rarely edited by hand)
- `jenkins-vars.yml` - per-repo Jenkins variables
- `readme-vars.yml` - source of truth for README; `README.md` is **generated**, never edit directly
- `package_versions.txt` - bot-updated SBOM, never hand-edit
- `LICENSE` - GPL-3.0 (LSIO standard)
- `root/` - overlay copied into image via `COPY /root /`

**Overlay structure under `root/`:**
- `root/defaults/` - template configs seeded into `/config` on first run
- `root/usr/bin/` - wrapper scripts that shadow distro binaries (e.g. `chromium`, `thunar`)
- Paths under `root/` mirror their destination in the container exactly.

### Dockerfile Conventions

**Base image:**
- Always `FROM ghcr.io/linuxserver/baseimage-selkies:alpine323` (or the pinned LSIO base).
- Never use upstream `alpine:` / `ubuntu:` directly — LSIO base provides s6-overlay, `abc` user, selkies.

**Required ARG/LABEL block (in this order):**
```dockerfile
ARG BUILD_DATE
ARG VERSION
ARG XFCE_VERSION
LABEL build_version="Linuxserver.io version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="thelamer"
ENV TITLE="Alpine XFCE"
```

**Single consolidated `RUN` layer:**
- One `RUN` with `\`-continued lines, sections delimited by `echo "**** section name ****"` markers.
- Standard section order: add icon → install packages → tweaks → cleanup.
- `apk add --no-cache` with packages one-per-line, alphabetically sorted.
- Always end with a cleanup block that removes `/config/.cache` and `/tmp/*`.

**Indentation and style:**
- Two-space indentation for continued lines inside `RUN`.
- LSIO convention is UPPERCASE Dockerfile instructions (`RUN`, `COPY`, `ENV`, `EXPOSE`, `VOLUME`).
- `COPY /root /` is always the final file-adding step before `EXPOSE` / `VOLUME`.

**Ports and volumes (LSIO webtop standard):**
- `EXPOSE 3001` (selkies web UI)
- `VOLUME /config`

**Dual-arch parity:**
- Any change to `Dockerfile` must be mirrored in `Dockerfile.aarch64`. The two files differ only where arch-specific packages are required.

### Shell Script Conventions (`root/defaults/`, `root/usr/bin/`)

- Shebang `#!/bin/bash` (LSIO base provides bash).
- Quote `"${HOME}"` / `"${VAR}"` expansions.
- Use POSIX `[ ... ]` test brackets, not `[[ ... ]]`, in this domain.
- Guard one-time setup with existence checks (`if [ ! -d ... ]; then ... fi`).
- Seed user config by copying from `/defaults/...` into `${HOME}/.config/...`.
- `exec` the final process so PID hierarchy stays clean.
- Redirect noisy output to `/dev/null 2>&1` where appropriate.
- Short inline `#` comments explain *why*, not *what*.

**Wrapper binary pattern (`root/usr/bin/chromium`):**
- Rename real binary (`mv /usr/bin/thunar /usr/bin/thunar-real`) in Dockerfile, then ship a wrapper at the original path that adjusts env/flags before `exec`-ing the real one.
- Detect privileged vs unprivileged containers via `grep -q 'Seccomp:.0' /proc/1/status` and branch sandbox flags accordingly.

### XML / Config Defaults

- XFCE channel XMLs live under `root/defaults/xfce/` and are copied into the user's `xfconf` dir by `startwm.sh` on first launch.
- Keep them minimal and match upstream XFCE schema.

### YAML Conventions (`jenkins-vars.yml` / `readme-vars.yml`)

- Two-space indentation.
- `repo_vars` is a list of `KEY = 'value'` strings (single-quoted) — format must match `Jenkinsfile` `environment {}` block verbatim.
- Keep keys in the order used by the LSIO template; the jenkins-builder bot relies on it.

### README Generation

- **Never edit `README.md` directly.** Regenerated from `readme-vars.yml` by the LSIO jenkins-builder and committed by a bot (`Bot Updating Templated Files`).
- All user-facing doc changes go in `readme-vars.yml`.

### Versioning

- Image version is derived from upstream `XFCE_VERSION` (`BUILD_VERSION_ARG` in `jenkins-vars.yml`) plus LSIO build suffix `-lsNN`.
- `package_versions.txt` is regenerated per build; never hand-edit.

---

## Domain 2: auth-gate (Bun + TypeScript)

### Layout

- `auth-gate/server.ts` — single-entry HTTP + WebSocket server (no framework).
- `auth-gate/package.json` — Bun-managed; dependency ranges are caret (`^1.2.3`).
- `auth-gate/tsconfig.json` — strict, `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`.
- `auth-gate/Dockerfile` — multi-stage on `oven/bun:1-alpine`.
- `auth-gate/bun.lock` / `bun.lockb` — committed; rebuilds must be reproducible.

### TypeScript Style

- **ES modules only.** `import { x } from "pkg"`, never `require`.
- **Strict mode on**, no implicit `any`, no unused locals, no unchecked indexed access.
- `camelCase` for functions, variables, locals.
- `PascalCase` for types, interfaces, classes.
- `SCREAMING_SNAKE_CASE` for module-level env-derived constants (e.g. `CLERK_SECRET_KEY`).
- Prefer `const` over `let`; never `var`.
- Top-level `await` is allowed for startup.
- `server.ts` is an entry point — no default export.

### Runtime Patterns

- `Bun.serve({ fetch, websocket })` is the single HTTP/WS entry point.
- `@clerk/backend` for session verification — instantiate the client **once** at module scope, reuse across requests.
- Read env via `Bun.env.VAR_NAME`; validate required vars at startup and throw **before** calling `Bun.serve`.
- Return typed `Response` objects from `fetch`; never throw out of the handler.
- 401 → redirect to Clerk sign-in; 403 → JSON error; 5xx → generic message + `console.error` with details.
- WebSocket upgrade rejection: return `new Response("Unauthorized", { status: 401 })` — do **not** call `server.upgrade()` on unauthenticated requests.

### Logging

- `console.log` / `console.error` only — no logger dependency.
- Prefix every line with component tag: `console.log("[auth-gate] ...")`.
- Log at minimum: redacted startup config, auth allow/deny decisions with reason, WS upgrade events.

### auth-gate Dockerfile

- Stage 1 (`deps`): `bun install --frozen-lockfile --production`.
- Stage 2 (runtime): fresh `oven/bun:1-alpine`, copy `node_modules` + `server.ts` + `tsconfig.json`.
- `CMD ["bun", "run", "server.ts"]`.
- `HEALTHCHECK` hitting `/healthz`.
- Drop to non-root where the base image supports it.

---

## Domain 3: Compose + Caddy deployment (`examples/deploy/`)

### compose.yml Conventions

- No `version:` key (modern Compose spec).
- **All secrets/hostnames via `${VAR}` substitution** — no literals. Known vars: `${DOMAIN}`, `${CLERK_SECRET_KEY}`, `${CLERK_PUBLISHABLE_KEY}`, `${CLERK_AUTHORIZED_PARTIES}`.
- **Named volumes** for persistent state (webtop `/config`, caddy data, caddy config).
- **Internal networks** — only `caddy` publishes ports to the host; `webtop` and `auth-gate` sit on an internal bridge and are unreachable from outside.
- `restart: unless-stopped` on all long-running services.
- `depends_on` with `condition: service_healthy` where a healthcheck exists.
- Service names are kebab-case: `auth-gate`, `webtop`, `caddy`.

### Caddyfile Conventions

- Rely on **automatic HTTPS** (ACME). No manual cert paths.
- Global `{ }` block only for ACME email + tuning.
- Per-site blocks keyed by `${DOMAIN}`.
- Security headers via `header` directive, always including:
  - `Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"`
  - `X-Content-Type-Options nosniff`
  - `X-Frame-Options DENY` (adjust only if webtop iframe needs force it)
  - `Referrer-Policy strict-origin-when-cross-origin`
- `reverse_proxy` targets `auth-gate:<port>` — auth-gate fronts webtop; Caddy never proxies webtop directly.
- WebSocket passthrough is implicit in Caddy `reverse_proxy`; do not add manual upgrade handling.

### Env Var Discipline

- Every variable referenced in `compose.yml` or `Caddyfile` MUST appear in `.env.example` with a comment describing its source (e.g. "From Clerk dashboard → API Keys").
- Never commit a real `.env`.
- Two-space indentation for YAML; LF line endings; file ends with single newline.

---

## Cross-Domain Rules

- **README is generated** from `readme-vars.yml`. Hand-edit `readme-vars.yml`, not `README.md`.
- **Never hand-edit** `package_versions.txt`.
- **File paths in docs** use backticks and are repo-relative.
- **No secrets in repo.** LSIO build-time creds come from Jenkins `credentials()`; runtime secrets come from `.env` / compose env.
- **No Conventional Commits prefix** — LSIO style uses a short imperative summary, optionally `(#PR)` suffix. Bot commits (`Bot Updating Package Versions`, `Bot Updating Templated Files`) must not be squashed or rewritten.
- **Indentation:** 2 spaces for YAML / TS / Caddyfile; match the existing file for shell.
- **No trailing whitespace**; files end with a single newline.

## What NOT to Add

- No application source to the LSIO base image — keep it a packaging repo.
- No Jest/Vitest/Node test harness in `auth-gate/` — if tests land, use `bun test`.
- No in-repo `docker-compose.yml` at root — the reference stack lives under `examples/deploy/`.
- No linter configs without also wiring them into CI.

---

*Convention analysis: 2026-04-13*

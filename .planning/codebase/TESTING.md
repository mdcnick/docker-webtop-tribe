# Testing Patterns

**Analysis Date:** 2026-04-13

## Reality Check

**There is no unit test suite anywhere in this repository.**

- The LSIO base image has never had unit tests and does not grow them — "testing" is the LSIO Jenkins build + container smoke test.
- `auth-gate/` (Bun/TypeScript) has no test suite either. It was smoke-tested manually during development against four endpoints (see below) and is verified the same way today.
- The deploy stack (`examples/deploy/`) is verified by bringing it up with `podman compose` / `docker compose` and running the same curl checks against the live domain.

If you add automated tests, document them here and update `CONVENTIONS.md`.

---

## Layer 1: LSIO Jenkins Pipeline (unchanged from upstream)

**Runner:** LSIO shared Jenkins pipeline (`Jenkinsfile`)

**Config sources:**
- `Jenkinsfile` — pipeline steps (rarely edited)
- `jenkins-vars.yml` — per-repo knobs consumed by the LSIO jenkins-builder
- Environment block in `Jenkinsfile` defines the CI contract

**Assertion mechanism:** pipeline stage exit codes + container log/screenshot inspection.

### What the pipeline exercises

1. **Build test** — `docker build` succeeds for both `Dockerfile` (x86_64) and `Dockerfile.aarch64` (arm64) on the `X86-64-MULTI` agent. A broken `RUN` layer fails the build stage.
2. **Container smoke test** — the freshly built image is launched with the CI env vars; the pipeline waits `CI_DELAY` seconds, then verifies the container is still running and the web UI is reachable.
3. **Web screenshot test** — a headless browser connects to `https://<container>:${CI_PORT}${CI_WEBPATH}` using `CI_AUTH`, waits `CI_WEB_SCREENSHOT_DELAY` seconds, and captures a screenshot uploaded as a build artifact for human review.

### CI variables

| Variable | Value | Purpose |
|---|---|---|
| `CI` | `true` | Enables CI test stages |
| `CI_WEB` | `true` | Run the web UI screenshot test |
| `CI_PORT` | `3001` | Selkies web port to probe |
| `CI_SSL` | `true` | Use HTTPS when probing |
| `CI_DELAY` | `60` | Seconds to wait after launch before probing |
| `CI_WEB_SCREENSHOT_DELAY` | `10` | Seconds to let the page render |
| `CI_DOCKERENV` | `TZ=US/Pacific` | Extra env vars passed to `docker run` |
| `CI_AUTH` | `user:password` | Basic-auth creds for the web probe |
| `CI_WEBPATH` | `` (empty) | Sub-path the UI is served from |
| `MULTIARCH` | `true` | Build and test both x86_64 and aarch64 |
| `PACKAGE_CHECK` | `false` (param) | If `true`, only rebuild when upstream packages changed |

### Package version + template drift

- With `PACKAGE_CHECK=true`, the pipeline rebuilds, diffs installed packages against `package_versions.txt`, and the bot commits an updated file as `Bot Updating Package Versions`. Treat `package_versions.txt` as a pipeline **output**, not an input.
- The pipeline also regenerates `README.md` from `readme-vars.yml`. If the tree would change, the bot commits `Bot Updating Templated Files`. Do not revert these.

### Pipeline does NOT cover

- `auth-gate/` (not built, not tested by LSIO CI)
- `examples/deploy/compose.yml` or `Caddyfile`
- Any end-to-end flow involving Clerk

Those are all manual for now.

---

## Layer 2: Manual smoke tests (the canonical loop)

This is the "did I break it?" workflow used during development and after every non-trivial change.

### 2a. Build locally

```bash
# LSIO base image
podman build -t webtop-tribe:dev .

# auth-gate (separate image, separate build context)
podman build -t auth-gate:dev ./auth-gate
```

For aarch64 parity on the base image, run with `-f Dockerfile.aarch64` on an arm64 host or via `buildx --platform linux/arm64`.

### 2b. Run single-container (base image only)

```bash
./examples/podman-run.sh
# or the equivalent docker run
```

Use this when the change only touches `Dockerfile` / `root/` and you don't need Clerk in the loop.

### 2c. Run the full stack (webtop + auth-gate + caddy)

```bash
cd examples/deploy
cp .env.example .env
# edit .env: DOMAIN, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_AUTHORIZED_PARTIES, ...
podman compose up -d        # or: docker compose up -d
```

### 2d. The four auth-gate smoke checks

These are the exact checks that were used during auth-gate development. Run **all four** on every auth-gate or Caddy change:

```bash
# (a) Health endpoint — 200, no auth required
curl -sS -o /dev/null -w "%{http_code}\n" https://${DOMAIN}/healthz
# expect: 200

# (b) Unauthenticated root — redirect to Clerk sign-in
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" https://${DOMAIN}/
# expect: 302 or 307 -> https://<clerk-domain>/sign-in...

# (c) Sign-in page reachable
curl -sSI https://${DOMAIN}/sign-in | head -1
# expect: HTTP/2 200

# (d) WebSocket upgrade without session — rejected
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGVzdA==" -H "Sec-WebSocket-Version: 13" \
  https://${DOMAIN}/websockify
# expect: 401
```

### 2e. Log inspection

```bash
podman logs -f auth-gate    # [auth-gate] ... auth decisions, WS upgrade events
podman logs -f webtop       # s6-overlay init, Xvnc, XFCE session
podman logs -f caddy        # ACME / TLS, proxy errors
```

### 2f. Teardown

```bash
podman compose down -v      # -v wipes named volumes; omit to preserve state
```

---

## What to smoke-test by change type

| Change | Minimum checks |
|---|---|
| `Dockerfile` / `Dockerfile.aarch64` (base) | Full build + `podman-run.sh` + desktop loads in browser via selkies |
| `root/` overlay | Build + run + `podman logs webtop` for s6-rc errors |
| `root/usr/bin/` wrapper | Build + launch the wrapped app in the live desktop (wrappers only execute when used) |
| `root/defaults/xfce/*.xml` | Build + run with a clean `/config`; inspect rendered desktop |
| `auth-gate/server.ts` | Rebuild `auth-gate:dev` + stack up + smoke checks (a)–(d) |
| `auth-gate/package.json` | `bun install` locally, rebuild image, smoke (a)–(d) |
| `examples/deploy/compose.yml` | `podman compose config` (lint) → `up -d` → smoke (a)–(d) |
| `examples/deploy/Caddyfile` | `caddy validate --config Caddyfile` → `up -d` → smoke (a)–(c) + header check |
| `examples/deploy/.env.example` | Diff against `compose.yml` + `Caddyfile` for missing vars |
| `readme-vars.yml` | Let CI regenerate README; visual diff in PR |
| `jenkins-vars.yml` / `Jenkinsfile` | Push to branch, watch Jenkins |

---

## Dockerfile / shell linting

- No `shellcheck` or `hadolint` config is committed. LSIO CI may run them centrally; locally, running `shellcheck root/defaults/startwm.sh root/usr/bin/chromium` and `hadolint Dockerfile Dockerfile.aarch64` is recommended before opening a PR.
- For `auth-gate/`, `bunx tsc --noEmit` against `auth-gate/tsconfig.json` is the closest thing to a type-check gate. Run it before rebuilding the image.

## Coverage

**Not applicable — there is no coverage metric.** Effective coverage of each domain:

- **LSIO image:** every `Dockerfile` line via the build stage; `startwm.sh` + default XMLs via first-run smoke; wrapper scripts only if actually launched in the screenshot window.
- **auth-gate:** four endpoints (healthz, /, /sign-in, /websockify upgrade). Nothing else is exercised automatically — authenticated-session paths, token refresh, and Clerk webhooks are in-browser manual only.
- **Deploy stack:** `up -d` succeeds and the four smoke checks pass against the real domain. Nothing verifies header presence, network isolation, or env-var completeness automatically.

## Known gaps / risk areas

- **aarch64 parity** — no automated diff between `Dockerfile` and `Dockerfile.aarch64`; drift is caught only if the arm64 build fails.
- **Wrapper scripts** (`root/usr/bin/chromium`, `thunar`) — syntax errors survive unless the wrapped app is actually launched during the screenshot window.
- **First-run XFCE defaults** — malformed XML only surfaces as a broken desktop screenshot.
- **auth-gate session path** — no regression test for Clerk session verification; entirely trusts `@clerk/backend`.
- **Caddy security headers** — not asserted anywhere; a removed `Strict-Transport-Security` would ship silently. A one-liner `curl -I` assertion would close this gap.
- **Network isolation** — nothing verifies that webtop is unreachable without going through auth-gate.
- **Env-var completeness** — nothing verifies that every `${VAR}` in `compose.yml` / `Caddyfile` exists in `.env.example`.
- **No negative tests** anywhere (e.g. that removing `--no-sandbox` fallback correctly breaks Chromium in an unprivileged container).

## If you add automated tests

- `auth-gate/` → use `bun test` and colocate as `auth-gate/*.test.ts`. Do **not** introduce Jest, Vitest, or Node.
- LSIO image → do **not** add language-level test stages to `Jenkinsfile` without confirming the LSIO shared pipeline will accept them.
- Deploy stack → prefer a shell script under `examples/deploy/smoke.sh` that wraps the four curl checks plus header assertions, so both humans and any future CI can run the same thing.

---

*Testing analysis: 2026-04-13*

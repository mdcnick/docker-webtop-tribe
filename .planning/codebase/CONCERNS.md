# Codebase Concerns

**Analysis Date:** 2026-04-13

## Tech Debt

**Fork drift from upstream:**
- Issue: Project is a "resolute rebase" fork of `linuxserver/docker-webtop`. Upstream changes (base image bumps, s6 layout shifts, Chromium config) must be periodically rebased in. No automated drift detection.
- Files: `Dockerfile`, `root/`, `README.md`
- Impact: Security patches and Chromium updates from LSIO may lag. Merge conflicts accumulate.
- Fix approach: Schedule periodic upstream sync; document rebase procedure; consider a CI job that diffs against `linuxserver/docker-webtop:latest`.

**Bot-driven `package_versions.txt`:**
- Issue: Automated commits (`Bot Updating Package Versions`) bump pinned package versions without human review. Recent commits: `1824852`, `9b6dd22`.
- Files: `package_versions.txt`, CI workflow driving the bot
- Impact: A compromised upstream APK mirror or malicious version bump would land on `master` unreviewed.
- Fix approach: Require PR + approval for bot commits; pin by digest where possible; add SBOM diffing to the bot PR.

**Chromium shim wrappers unaudited:**
- Issue: `root/usr/bin/chromium*` wrapper scripts were not reviewed this session. They inject flags for sandboxing / GPU / user-data-dir and are trust-critical.
- Files: `root/usr/bin/chromium*`
- Impact: A subtle flag mistake (e.g. `--no-sandbox` unconditionally, or `--disable-web-security`) would silently weaken the browser for every user.
- Fix approach: Audit all wrapper scripts; add a test that asserts `--no-sandbox` is only set under an explicit opt-in env var.

**`hermes-agent` baked into image:**
- Issue: `hermes-agent` v2026.4.13 is installed at image build time, pulling a full Python dependency tree (see supply-chain section). Bundling an agent framework inside a desktop image couples two release cadences.
- Impact: Every webtop rebuild drags in the agent's transitive deps; CVEs in any of them force a webtop rebuild.
- Fix approach: Move `hermes-agent` to a sidecar container or optional install; decouple release cycles.

## Known Bugs

**Podman HEALTHCHECK warning:**
- Symptoms: Build emits a warning that `HEALTHCHECK` is ignored under OCI image format in podman. Container health reporting does not work under podman.
- Files: `Dockerfile` (HEALTHCHECK directive)
- Trigger: `podman build` of this image; `podman ps` shows no health status.
- Workaround: Use Docker format (`--format docker`) when building with podman, or rely on external health probes (Caddy upstream check, systemd timer).

**s6 `init-enterprise` hook degrades silently:**
- Symptoms: Hook uses `set -e` but most operations are suffixed with `|| true`. If `ENTERPRISE_SUDO=true` and `apk add sudo` fails (e.g., offline mirror), the container still boots with sudo unavailable.
- Files: `root/etc/s6-overlay/s6-rc.d/init-enterprise/run` (or equivalent)
- Trigger: Network failure to APK repo during init, with `ENTERPRISE_SUDO=true`.
- Workaround: Remove `|| true` from installation steps that are required for the requested feature flag; fail loudly.

**Rootless podman `--userns=keep-id` footgun:**
- Symptoms: If users pass `--userns=keep-id`, LSIO s6 init fails silently in a way that is hard to diagnose (took several iterations to identify).
- Files: `examples/podman-run.sh`, README podman section
- Trigger: Rootless podman run with `--userns=keep-id`.
- Workaround: Documented "do NOT use `--userns=keep-id`" in `examples/podman-run.sh`. Consider adding a runtime check in `init-adduser` that detects the ID mapping and aborts with a clear error.

## Security Considerations

**Chromium sandbox inside container:**
- Risk: Chromium's setuid sandbox does not work inside a default Docker/podman container. Required runtime flags: `--security-opt seccomp=unconfined --shm-size=1g` (or `--cap-add SYS_ADMIN`, which is worse).
- Files: `README.md`, `docker-compose.yaml` examples, `root/usr/bin/chromium*`
- Current mitigation: Documented in README; compose examples set `shm_size: "1gb"` and seccomp profile.
- Recommendations: Ship a minimal custom seccomp profile rather than `seccomp=unconfined`; document the tradeoff; audit wrapper scripts to ensure `--no-sandbox` is not the fallback.

**Supply chain — `hermes-agent` Python dependencies:**
- Risk: Image build installs a broad, fast-moving Python dependency tree: `openai`, `anthropic`, `pydantic`, `cryptography`, `pyjwt`, `prompt_toolkit`, `jinja2`, `requests`, `firecrawl-py`, `exa-py`, `edge-tts`, `fal-client`, `parallel-web`, `tenacity`, `httpx`. Any compromised package lands in every webtop. A Rust toolchain is pulled into the builder stage to compile native extensions.
- Files: `Dockerfile` (hermes-agent install stage), builder stage with Rust toolchain
- Current mitigation: Pinned `hermes-agent` version; Rust toolchain confined to builder stage and discarded.
- Recommendations: Pin all transitive deps via a lockfile (`uv.lock` / `requirements.txt` with hashes); use `pip install --require-hashes`; enable Dependabot/Renovate with review required; generate SBOM per build; consider not baking hermes-agent into the base image (see tech debt).

**Supply chain — `auth-gate/` Bun + Clerk:**
- Risk: `auth-gate/` is a Bun project depending on `@clerk/backend ^1.15.0` plus its transitive tree. Single-developer-session code, not code-reviewed.
- Files: `auth-gate/package.json`, `auth-gate/bun.lockb`, `auth-gate/src/**`
- Current mitigation: Lockfile committed.
- Recommendations: Second-pair review pass on all `auth-gate/` source; add linting/type-check to CI; pin `@clerk/backend` to an exact version; audit transitive deps; add `bun audit` (or equivalent) in CI.

**Clerk secrets on disk:**
- Risk: Clerk publishable and secret keys live in plaintext `.env` on the VPS. If the filesystem is compromised (backup leak, ops SSH compromise), keys leak and an attacker can mint valid Clerk sessions for the instance.
- Files: `.env` (gitignored), `auth-gate/.env`
- Current mitigation: `.env` is gitignored; file permissions should be `600`.
- Recommendations: Store secrets in a secret manager (systemd `LoadCredential=`, HashiCorp Vault, podman secrets, or at minimum root-owned `0600` files); rotate Clerk keys on suspected compromise; document rotation runbook.

**Caddy auto-HTTPS inbound exposure:**
- Risk: Caddy's ACME flow requires inbound `:80` and `:443` reachable from Let's Encrypt. Standard, but it means the host exposes two public ports that must stay patched.
- Files: `Caddyfile`, deployment docs
- Current mitigation: Caddy handles renewal automatically; standard practice.
- Recommendations: Note in deployment docs; optionally use DNS-01 challenge to avoid inbound `:80` exposure; keep Caddy auto-updated.

**`FORCE_HTTPS` trusts `X-Forwarded-Proto` blindly:**
- Risk: When `FORCE_HTTPS=true`, auth-gate trusts the `X-Forwarded-Proto` header to decide whether to redirect. If the LB is misconfigured (or bypassed), a client sending `X-Forwarded-Proto: https` over plain HTTP bypasses the redirect and interacts with auth-gate over cleartext.
- Files: `auth-gate/src/**` (HTTPS redirect middleware)
- Current mitigation: Intended to run only behind Caddy which strips/sets the header.
- Recommendations: Verify the source IP against a trusted-proxy list before honoring `X-Forwarded-Proto`; or bind auth-gate to `127.0.0.1` so only Caddy can reach it; document the trusted-proxy assumption.

**No rate limiting on `/auth/sign-in`:**
- Risk: Sign-in endpoint has no rate limiting — brute-force surface for credential stuffing against the Clerk instance. Clerk itself has protections, but the fronting endpoint adds a free amplifier.
- Files: `auth-gate/src/**` (sign-in route)
- Current mitigation: Clerk-side rate limiting only.
- Recommendations: Add per-IP rate limiting in auth-gate (simple token bucket) or in Caddy (`rate_limit` module); add CAPTCHA on repeated failures; log and alert on burst.

**Allow-list empty-set footgun:**
- Risk: If both `ALLOWED_EMAILS` and `ALLOWED_USER_IDS` are empty, allow-list mode degrades to "any signed-in Clerk user can access the webtop." If the Clerk instance has open sign-up, this is effectively public.
- Files: `auth-gate/src/**` (allow-list check), `README.md`
- Current mitigation: Documented; default behavior of empty-set is called out.
- Recommendations: Refuse to start when allow-list mode is enabled but both lists are empty; require an explicit `ALLOWED_OPEN=true` opt-in; log a warning on every request when in degraded mode.

## Performance Bottlenecks

**auth-gate WebSocket proxy buffering:**
- Problem: WebSocket proxy uses Bun's client WebSocket plus a manual pipe. Outbound frames from the browser are queued while the upstream connection is still being established. A pathological client that opens a socket, floods frames, and never lets the upstream complete handshake can grow the queue unbounded.
- Files: `auth-gate/src/**` (WebSocket proxy / pipe logic)
- Cause: No cap on the pending-outbound queue; no timeout on upstream connect.
- Improvement path: Cap the queue at N frames / M bytes; close the client socket with policy-violation code on overflow; add a 5–10s upstream connect timeout; add a metric for queue depth.

## Fragile Areas

**auth-gate WebSocket pipe:**
- Files: `auth-gate/src/**` (WS proxy)
- Why fragile: Manual pipe between two async WebSocket endpoints with buffering, backpressure, and close-code propagation. Easy to regress on half-close, ping/pong forwarding, or error propagation.
- Safe modification: Add integration tests that exercise open/close/ping/pong/binary/text/large-frame/early-close before touching this file.
- Test coverage: Unknown — assume none until verified.

**s6 init hooks:**
- Files: `root/etc/s6-overlay/s6-rc.d/**`
- Why fragile: Mix of `set -e` and `|| true`; order-of-operations matters; failures are often silent.
- Safe modification: Run the full image in a clean container after any change; verify `s6-rc -a list` and service state.

## Scaling Limits

**Single-tenant webtop:**
- Current capacity: One user session per container. `auth-gate` gates a single upstream webtop.
- Limit: Horizontal scale requires per-user containers and a routing layer, which is out of scope for this project.
- Scaling path: Not a goal. Document as single-tenant.

## Dependencies at Risk

**`@clerk/backend`:**
- Risk: Pinned with a caret (`^1.15.0`) — minor/patch bumps land automatically on `bun install`.
- Impact: A compromised or breaking release would propagate to fresh builds.
- Migration plan: Pin to an exact version; review changelog before bumping.

**`hermes-agent` transitive Python tree:**
- Risk: Broad surface, no hash-pinned lockfile assumed.
- Impact: One compromised package compromises the image.
- Migration plan: Vendor via lockfile with hashes; SBOM-diff on every bump.

## Missing Critical Features

**Secret rotation runbook:**
- Problem: No documented procedure for rotating Clerk keys, Caddy-issued certs, or any other secret.
- Blocks: Incident response; routine hygiene.

**Rate limiting at the edge:**
- Problem: Neither Caddy nor auth-gate enforce rate limits on authentication endpoints.
- Blocks: Brute-force resistance.

**Trusted-proxy verification:**
- Problem: `FORCE_HTTPS` and any future header-based trust has no trusted-proxy check.
- Blocks: Safe deployment behind arbitrary LBs.

## Test Coverage Gaps

**Chromium wrapper scripts:**
- What's not tested: Flag composition in `root/usr/bin/chromium*`.
- Files: `root/usr/bin/chromium*`
- Risk: Silent sandbox weakening.
- Priority: High.

**auth-gate WebSocket proxy:**
- What's not tested: Buffering, backpressure, close propagation, header trust.
- Files: `auth-gate/src/**`
- Risk: Memory leak under hostile clients; auth bypass via `X-Forwarded-Proto`.
- Priority: High.

**s6 init hooks under failure modes:**
- What's not tested: APK mirror failure, missing env vars, rootless podman ID mapping.
- Files: `root/etc/s6-overlay/s6-rc.d/**`
- Risk: Silent degraded boot.
- Priority: Medium.

**Allow-list enforcement:**
- What's not tested: Empty-set behavior, email canonicalization, user-ID matching.
- Files: `auth-gate/src/**`
- Risk: Unintended public access.
- Priority: High.

---

*Concerns audit: 2026-04-13*

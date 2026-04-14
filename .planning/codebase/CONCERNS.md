# Codebase Concerns

**Analysis Date:** 2026-04-13

This repository is a downstream fork ("tribe" / "resolute rebase") of `linuxserver/docker-webtop` targeting the Alpine XFCE flavor. It is a thin image assembly layer (Dockerfiles + a handful of shell shims and XFCE defaults) over `ghcr.io/linuxserver/baseimage-selkies:alpine323`. Almost all risk lives in (a) what the base image does, (b) the wrapper shims in `root/usr/bin/`, and (c) fork maintenance process.

## Tech Debt

**Duplicated Dockerfiles for multi-arch:**
- Issue: `Dockerfile` and `Dockerfile.aarch64` are byte-for-byte identical except for the `FROM` line. Any change must be made in two places and it is easy to drift.
- Files: `Dockerfile`, `Dockerfile.aarch64`
- Impact: Silent arch divergence (e.g. a package added to x86_64 but forgotten on arm64) is not caught by CI since there are no tests.
- Fix approach: Collapse to a single `Dockerfile` parameterized with `ARG BASE_IMAGE` and let buildx pick per-platform, or use `TARGETARCH` in a single `FROM`.

**Wrapper shim duplication (`chromium` vs `chromium-browser`):**
- Issue: `root/usr/bin/chromium` and `root/usr/bin/chromium-browser` are nearly identical bash scripts that diverge only in the `BIN` target (`/usr/bin/chromium-browser` vs `/usr/lib/chromium/chromium-launcher.sh`). This creates a shim that calls another shim.
- Files: `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`
- Impact: `chromium` -> `chromium-browser` -> `chromium-launcher.sh` chain; `pgrep chromium` and `Singleton*` cleanup run twice, doubling the `--no-sandbox` decision surface. A future Alpine chromium package change that removes `/usr/bin/chromium-browser` will silently break the outer shim.
- Fix approach: Collapse to a single wrapper that execs `chromium-launcher.sh` directly, or drop one of the two.

**`thunar` wrapper just unsets `LD_PRELOAD`:**
- Issue: The real `thunar` is renamed to `thunar-real` in the Dockerfile and a bash shim execs it with `LD_PRELOAD` cleared. The reason is not documented in the shim and not referenced in any README/commit message visible in the repo.
- Files: `root/usr/bin/thunar`, `Dockerfile` line 32-34, `Dockerfile.aarch64` line 32-34
- Impact: Future maintainers will not know what `LD_PRELOAD` this is avoiding (likely a gtk/selkies/libnss preload from the base image). If the upstream base image ever stops setting `LD_PRELOAD`, the shim is dead code; if the preload is required for other binaries, thunar now silently lacks it.
- Fix approach: Add an inline comment pointing at the base image preload being stripped, and guard with `[ -n "$LD_PRELOAD" ]` so the shim is a no-op otherwise. Consider `exec thunar-real "$@"` instead of a plain call so signals propagate.

**Shims do not `exec`:**
- Issue: Neither `chromium`, `chromium-browser`, nor `thunar` use `exec` to replace the bash process. Every launched app keeps a dangling bash parent.
- Files: `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`, `root/usr/bin/thunar`
- Impact: Extra PID per window, signals (SIGTERM from xfce session end) go to bash not the app, exit codes get swallowed.
- Fix approach: `exec "${BIN}" ...` and `exec thunar-real "$@"`.

**`startwm.sh` discards all output:**
- Issue: `exec dbus-launch --exit-with-session /usr/bin/xfce4-session > /dev/null 2>&1`
- Files: `root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`
- Impact: When XFCE fails to start, there is nothing in container logs to debug. Support issues become unanswerable without `docker exec` re-runs.
- Fix approach: Log to `/config/.xsession-errors` or leave stderr attached so `docker logs` works.

**`startwm_wayland.sh` race on Xwayland:**
- Issue: `Xwayland :1 &` followed by `sleep 2` then `xfce4-session`. Fixed 2s sleep is a classic race fix.
- Files: `root/defaults/startwm_wayland.sh` lines 10-12
- Impact: Under load, 2s may be insufficient and the session starts before Xwayland is ready; on fast hosts, 2s is wasted startup time.
- Fix approach: Poll for the socket (`while [ ! -S /tmp/.X11-unix/X1 ]; do sleep 0.1; done`) or use `Xwayland -displayfd`.

**No per-channel Dockerfile comments explain Alpine-specific workarounds:**
- The `GTK_THEME=Adwaita:light` in chromium shim is labelled "Bugfix for Chromium in Alpine" but not linked to any upstream issue.
- Fix approach: Add a URL to the relevant Alpine/chromium bug.

## Security Considerations

**Chromium sandbox disabled by default on non-privileged containers:**
- Risk: The shim inspects `/proc/1/status` for `Seccomp: 0` (i.e., container running with `--privileged` or `--security-opt seccomp=unconfined`). If NOT detected, it launches chromium with `--no-sandbox --test-type`. Most users run non-privileged, so the common path is **no chromium sandbox**.
- Files: `root/usr/bin/chromium` lines 13-18, `root/usr/bin/chromium-browser` lines 13-18
- Current mitigation: None. `--test-type` silences the "you are using an unsupported command-line flag" banner, which also hides the warning from end users.
- Recommendations:
  - Document loudly in README that the default configuration runs chromium without the sandbox and that any browser RCE is a container-root RCE (or abox-user RCE plus whatever the container can reach).
  - Prefer `--user-data-dir` isolation and recommend users pass `--cap-add SYS_ADMIN` or an unprivileged-userns seccomp profile so the real sandbox can be used.
  - Drop `--test-type`; keep the banner so users know the sandbox is off.
  - Detect via `unshare -U true` capability probe instead of the seccomp heuristic, which is fragile (a user can tighten seccomp but still have user-namespace support, and vice versa).

**Exposed full desktop on port 3001:**
- Risk: The base image serves a selkies-based web desktop on `3001`. This is a remote interactive shell (file manager, terminal, browser) reachable over HTTP(S). Any authentication is handled entirely by the base image.
- Files: `Dockerfile` line 48, `jenkins-vars.yml` (`CI_AUTH = 'user:password'` default)
- Current mitigation: Base image supports `CUSTOM_USER`/`PASSWORD` env vars; CI default is literally `user:password`.
- Recommendations: README must stress never expose 3001 to the internet without a reverse proxy enforcing auth + TLS. Consider shipping a warning at container start if `PASSWORD` is unset or equals default.

**Thunar + xfce4-terminal inside the web desktop = arbitrary container command execution:**
- Risk: Anyone who reaches the desktop has a full shell as the container user (`abc` in lsio base) and read/write access to `/config` and any bind mounts.
- Files: `Dockerfile` line 30 (installs `xfce4-terminal`, `thunar`, `mousepad`)
- Current mitigation: Relies entirely on web-facing auth of the base image.
- Recommendations: Consider a "kiosk" variant that omits the terminal and thunar for browser-only use cases.

**`curl` of icon at build time with no checksum:**
- Risk: `curl -o /usr/share/selkies/www/icon.png https://raw.githubusercontent.com/.../webtop-logo.png` inside the build pulls an asset with no integrity check. A GitHub outage or upstream repo takeover would either break the build or silently swap the icon.
- Files: `Dockerfile` lines 17-19, `Dockerfile.aarch64` lines 17-19
- Current mitigation: None.
- Recommendations: Vendor the icon into `root/` and `COPY` it, or add `--fail` and a sha256 check.

**`rm -rf /config/.cache` during image build:**
- Risk: `/config` is declared `VOLUME` on the next line, so anything written to it during build is discarded anyway; this `rm` is cosmetic. More importantly, touching `/config` in a `RUN` before declaring it as a volume bakes a layer that sets ownership on a path that will be shadowed at runtime, which can surprise users who mount over it.
- Files: `Dockerfile` lines 40-42
- Recommendation: Drop the `/config/.cache` line entirely, or move the `VOLUME` declaration earlier.

## Fragile Areas

**Seccomp heuristic in chromium shim:**
- Files: `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`
- Why fragile: `grep -q 'Seccomp:.0' /proc/1/status` assumes the kernel exposes that field and that "0" means unconfined. On kernels where `/proc/1/status` uses a different format, or where seccomp is unconfined but user namespaces are still unavailable, the shim silently picks the wrong branch.
- Safe modification: Add a fallback branch and log the detected mode to stderr on first run.
- Test coverage: None.

**Singleton lock cleanup races:**
- Files: `root/usr/bin/chromium` lines 9-11, `root/usr/bin/chromium-browser` lines 9-11
- Why fragile: `pgrep chromium` will miss processes mid-exec and will match anything named "chromium" (e.g. `chromium-launcher.sh`). Under rapid relaunch, the Singleton file may be deleted while another instance is mid-startup.
- Safe modification: Use chromium's own `--user-data-dir` per-profile locking, or skip the cleanup and let chromium handle it.

**Fork drift from upstream `linuxserver/docker-webtop`:**
- Why fragile: The image has `LABEL maintainer="thelamer"` (upstream maintainer) and `jenkins-vars.yml` still references `LS_USER = 'linuxserver'`, `LS_REPO = 'docker-webtop'`, `DOCKERHUB_IMAGE = 'linuxserver/webtop'`. The fork's CI metadata is therefore still pointing at upstream identifiers.
- Files: `jenkins-vars.yml`, `Dockerfile` line 10, `Dockerfile.aarch64` line 10
- Impact: Rebase conflicts are likely (recent commit message: "update readme for resolute rebase"). Any `Jenkinsfile` automation that assumes these names will push to upstream-named repos or pull upstream branches.
- Safe modification: Fork-ify `jenkins-vars.yml` and `maintainer` labels; document the rebase cadence.

## Maintenance / Process Concerns

**Bot-driven commit history:**
- Issue: Recent commits are overwhelmingly "Bot Updating Package Versions" and "Bot Updating Templated Files" (see `git log`). `package_versions.txt` is 184KB and is committed on every run.
- Impact: Human review of actual behavior changes is buried under noise. A malicious or accidental change to a wrapper shim is easy to miss in a bot-heavy history.
- Fix approach: Require human review for changes under `root/`, `Dockerfile*`, and `jenkins-vars.yml` via CODEOWNERS; exclude `package_versions.txt` from diffs on PRs.

**No tests, no CI lint:**
- Issue: No test suite, no shellcheck, no hadolint. The shell shims and Dockerfiles are never statically validated.
- Files: repo root (no `.github/workflows` for lint, no `tests/`)
- Impact: A typo in `root/usr/bin/chromium` (e.g. missing `fi`) would ship.
- Fix approach: Add `hadolint Dockerfile*` and `shellcheck root/usr/bin/* root/defaults/*.sh` to CI. Add a smoke test that boots the container and curls `:3001`.

**`.gitignore` is 18 bytes:**
- Files: `.gitignore`
- Impact: Easy to accidentally commit local editor artifacts or secrets during rebase operations.
- Fix approach: Expand with standard editor/OS patterns.

**Upstream base image tag is floating on minor (`alpine323`):**
- Files: `Dockerfile` line 3, `Dockerfile.aarch64` line 3
- Impact: `ghcr.io/linuxserver/baseimage-selkies:alpine323` is a moving tag. Builds are not reproducible; a base image rebuild can silently change chromium behavior and break the seccomp heuristic.
- Fix approach: Pin to a digest (`@sha256:...`) in release builds, or add a renovate-style PR bot that bumps the pin with human review.

## Operational Concerns

**Privileged-container expectation is implicit:**
- Issue: The chromium shim behaves differently under privileged vs non-privileged containers. README likely tells users to run privileged for "full" behavior, but that choice has major security implications (see Security section).
- Files: `root/usr/bin/chromium` lines 13-18
- Impact: Users who want a working chromium sandbox must run privileged, which gives the web desktop root on the host.
- Recommendation: Document the trade-off explicitly. Provide a non-privileged recipe with `--security-opt seccomp=unconfined` + user namespaces that keeps chromium sandbox intact without full privilege.

**`/config` volume ownership:**
- Issue: `/config` is declared as a volume after files are written into it during build. The base image's init chowns `/config` at runtime; any user bind-mounting `/config` to an existing host directory may see permission errors on first start that are not logged anywhere due to `startwm.sh` redirecting output to `/dev/null`.
- Files: `Dockerfile` lines 40-50
- Recommendation: Do not write to `/config` during build. Keep `startwm.sh` stderr attached to container logs so permission errors surface.

**No resource limits / no guidance on ephemeral storage:**
- Issue: Chromium cache + user profile live under `/config/.cache` and `/config/.config/chromium`, which are on the user-supplied volume. A long-running desktop can exhaust user disk.
- Recommendation: Document cache cleanup guidance, or mount `/config/.cache` on an ephemeral volume by default.

## Test Coverage Gaps

**Everything:**
- What's not tested: There are no unit tests, integration tests, or lint checks in the repo. `Jenkinsfile` drives image builds and `CI_*` vars suggest a screenshot-based smoke test via the lsio build pipeline, but nothing repo-local verifies the shims or startwm scripts.
- Files: entire repo
- Risk: Silent breakage of the chromium shim, thunar shim, or startwm scripts across rebases.
- Priority: Medium. Add at minimum `shellcheck` + `hadolint` in a GitHub Action; they are free and catch real bugs in files this small.

---

*Concerns audit: 2026-04-13*

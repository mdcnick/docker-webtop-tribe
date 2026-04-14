# Coding Conventions

**Analysis Date:** 2026-04-13

This repository is a LinuxServer.io (LSIO) Docker image fork (webtop / Alpine XFCE). It contains no application source code — only Dockerfiles, shell scripts, XML defaults, and LSIO CI metadata. Conventions below follow upstream LSIO standards.

## Repository Layout Conventions

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

## Dockerfile Conventions

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
- Lowercase Dockerfile instructions are acceptable where upstream uses them, but LSIO convention is UPPERCASE (`RUN`, `COPY`, `ENV`, `EXPOSE`, `VOLUME`).
- `COPY /root /` is always the final file-adding step before `EXPOSE` / `VOLUME`.

**Ports and volumes (LSIO webtop standard):**
- `EXPOSE 3001` (selkies web UI)
- `VOLUME /config`

**Dual-arch parity:**
- Any change to `Dockerfile` must be mirrored in `Dockerfile.aarch64`. The two files differ only where arch-specific packages are required.

## Shell Script Conventions (`root/defaults/`, `root/usr/bin/`)

**Shebang:**
- `#!/bin/bash` (LSIO standard; `/bin/bash` is present in the base image). Note that `root/usr/bin/chromium` uses `#! /bin/bash` — either spacing is tolerated.

**Style patterns observed:**
- Quote `"${HOME}"` and `"${VAR}"` expansions.
- Use `[ ... ]` test brackets (POSIX), not `[[ ... ]]`.
- Guard one-time setup with existence checks (`if [ ! -d ... ]; then ... fi`).
- Seed user config by copying from `/defaults/...` into `${HOME}/.config/...`.
- Terminal entry points `exec` the final process so PID hierarchy stays clean.
- Redirect noisy output to `/dev/null 2>&1` where appropriate.
- Short inline `#` comments explain *why* (e.g. "Bugfix for Chromium in Alpine"), not *what*.

**Wrapper binary pattern (`root/usr/bin/chromium`):**
- Rename real binary (`mv /usr/bin/thunar /usr/bin/thunar-real` in Dockerfile), then ship a wrapper at the original path that adjusts env and flags before `exec`-ing the real one.
- Detect privileged vs unprivileged containers via `grep -q 'Seccomp:.0' /proc/1/status` and branch sandbox flags accordingly.

## XML / Config Defaults

- XFCE channel XMLs live under `root/defaults/xfce/` and are copied into the user's `xfconf` dir by `startwm.sh` on first launch.
- Treat these as user-editable defaults — keep them minimal and match upstream XFCE schema.

## YAML Conventions

**`jenkins-vars.yml` / `readme-vars.yml`:**
- Two-space indentation.
- `repo_vars` is a list of `KEY = 'value'` strings (quoted with single quotes) — format must match `Jenkinsfile` `environment {}` block verbatim.
- Keep keys in the order used by the LSIO template; the jenkins-builder bot relies on it.

## README Generation

- **Never edit `README.md` directly.** It is regenerated from `readme-vars.yml` by the LSIO jenkins-builder and committed by a bot ("Bot Updating Templated Files").
- All user-facing doc changes go in `readme-vars.yml`.

## Commit Conventions

Observed in `git log`:
- Bot commits: `Bot Updating Package Versions`, `Bot Updating Templated Files` — do not squash or rewrite.
- Human commits: short imperative summary, optionally `(#PR)` suffix (e.g. `update readme for resolute rebase (#405)`).
- No Conventional Commits prefix (`feat:`, `fix:`) — LSIO does not use them.

## Versioning

- Image version is derived from upstream `XFCE_VERSION` (`BUILD_VERSION_ARG` in `jenkins-vars.yml`) plus LSIO build suffix `-lsNN`.
- `package_versions.txt` is regenerated per build; never hand-edit.

## What NOT to Add

- No application source, no `package.json`, no linter configs — this is a packaging repo.
- No `docker-compose.yml` in-repo (examples live in `readme-vars.yml`).
- No secrets; all credentials are injected via Jenkins `credentials()` at build time.

---

*Convention analysis: 2026-04-13*

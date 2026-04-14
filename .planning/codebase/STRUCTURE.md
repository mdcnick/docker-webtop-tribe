# Codebase Structure

**Analysis Date:** 2026-04-13

## Directory Layout

```
docker-webtop-tribe/
├── Dockerfile                    # Multi-stage x86_64 build (hermes-builder + LSIO selkies final)
├── Dockerfile.aarch64            # aarch64 variant, same overlay
├── Jenkinsfile                   # LSIO CI pipeline
├── jenkins-vars.yml              # CI variables consumed by Jenkinsfile
├── package_versions.txt          # Bot-updated apk package manifest
├── readme-vars.yml               # Source of truth for README.md (LSIO templating)
├── README.md                     # Generated from readme-vars.yml
├── .env.example                  # Root-level env sample (image build knobs)
├── .gitignore
├── LICENSE
│
├── root/                         # Filesystem overlay COPYed to / in the final image
│   ├── defaults/
│   │   ├── startwm.sh            # X11 XFCE session launcher (exec'd by base image)
│   │   ├── startwm_wayland.sh    # Wayland variant (starts Xwayland :1 first)
│   │   └── xfce/                 # xfconf seed copied into ${HOME} on first launch
│   │       ├── xfce4-desktop.xml
│   │       ├── xfce4-panel.xml
│   │       ├── xfwm4.xml
│   │       └── xsettings.xml
│   ├── usr/
│   │   ├── bin/                  # PATH shims overriding Alpine binaries
│   │   │   ├── chromium          # Sandbox-aware Chromium launcher
│   │   │   ├── chromium-browser  # Same logic, targets chromium-launcher.sh
│   │   │   └── thunar            # Unsets LD_PRELOAD, execs thunar-real
│   │   └── share/applications/
│   │       └── hermes.desktop    # App launcher entry for hermes
│   └── etc/
│       ├── xdg/autostart/
│       │   └── hermes.desktop    # XFCE session autostart for hermes
│       └── s6-overlay/s6-rc.d/
│           ├── init-enterprise/
│           │   ├── run                       # Applies GECOS/shell/groups/sudo to abc from env
│           │   ├── type                      # "oneshot"
│           │   ├── up
│           │   └── dependencies.d/
│           │       └── init-adduser          # Runs after LSIO's adduser service
│           └── user/contents.d/
│               └── init-enterprise           # Registers service into user bundle
│
├── auth-gate/                    # Bun + Clerk reverse proxy (sidecar image)
│   ├── Dockerfile                # Multi-stage bun:1-alpine
│   ├── package.json              # @clerk/backend dep, bun scripts
│   ├── tsconfig.json
│   ├── server.ts                 # Bun.serve: HTTP + WS proxy with Clerk verify
│   └── .dockerignore
│
├── examples/                     # Deployment recipes (not built into the image)
│   ├── podman-run.sh             # Imperative rootless podman quickstart
│   ├── webtop.container          # Podman Quadlet unit for webtop
│   ├── webtop-config.volume      # Podman Quadlet unit for /config named volume
│   └── deploy/                   # Full VPS topology (Caddy + gate + webtop)
│       ├── compose.yml           # docker-compose / podman-compose entrypoint
│       ├── Caddyfile             # TLS terminator + HSTS + reverse_proxy
│       ├── .env.example          # DOMAIN, Clerk keys, allow-lists, LETSENCRYPT_EMAIL
│       └── webtop.service        # systemd unit that runs the compose stack
│
├── .github/                      # Issue/PR templates and LSIO shared workflows
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│
└── .planning/
    └── codebase/                 # GSD codebase maps (this directory)
```

## Directory Purposes

**Repo root:**
- Purpose: Image build definitions and LSIO pipeline metadata. No application source for the desktop itself — that comes from upstream Alpine packages.
- Contains: `Dockerfile`, `Dockerfile.aarch64`, `Jenkinsfile`, `jenkins-vars.yml`, `package_versions.txt`, `readme-vars.yml`, `README.md`, `.env.example`.
- Key files: `Dockerfile` (multi-stage, authoritative for x86_64 builds), `readme-vars.yml` (edit this, not `README.md`).

**`root/`:**
- Purpose: Filesystem overlay COPYed into the final webtop image via `COPY /root /` in `Dockerfile`. Path layout mirrors the final container paths verbatim — `root/etc/foo` becomes `/etc/foo` at runtime.
- Contains: s6 service definitions, XFCE defaults, binary wrappers, desktop entries.
- Key files: `root/defaults/startwm.sh`, `root/etc/s6-overlay/s6-rc.d/init-enterprise/run`, `root/usr/bin/chromium`.

**`root/defaults/`:**
- Purpose: Installed to `/defaults/` — the LSIO convention for image-shipped config seeded into the user's HOME on first run. The Selkies base image execs `/defaults/startwm.sh` to start the desktop.
- Contains: Session launch scripts and the `xfce/` seed directory.

**`root/defaults/xfce/`:**
- Purpose: xfconf channel XML seeded into `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml/` on first launch, guarded by a directory-existence check in `startwm.sh` so user edits in `/config` survive upgrades.
- Contains: Panel, desktop, xfwm4, xsettings channels.

**`root/usr/bin/`:**
- Purpose: Binary-name shims that take precedence over Alpine binaries on `PATH` to fix container-specific quirks (Chromium sandbox/GTK, Thunar LD_PRELOAD). `root/usr/bin/thunar` depends on the Dockerfile having renamed the real binary to `/usr/bin/thunar-real`.

**`root/etc/s6-overlay/s6-rc.d/`:**
- Purpose: s6-rc service graph. Each subdirectory is a service with `type`, `run`, and optional `dependencies.d/` and `up`.
- New services must also be registered in a bundle under `user/contents.d/` (an empty file whose name is the service name).
- Current additions: `init-enterprise` (oneshot, runs after `init-adduser`, configures the `abc` user from env vars).

**`auth-gate/`:**
- Purpose: Standalone Bun + TypeScript reverse proxy that enforces Clerk auth in front of webtop. Built as its own image (`localhost/webtop-auth-gate`), not baked into the webtop image.
- Contains: single `server.ts`, Bun/TS config, multi-stage Dockerfile based on `bun:1-alpine`.
- Key files: `auth-gate/server.ts` (all logic lives here), `auth-gate/Dockerfile`, `auth-gate/package.json`.
- Dependencies: `@clerk/backend`.

**`examples/`:**
- Purpose: Deployment recipes users copy and adapt. Not referenced by the image build.
- Contains: imperative podman script, Quadlet units, full compose topology.
- Key files: `examples/deploy/compose.yml`, `examples/deploy/Caddyfile`, `examples/deploy/webtop.service`.

**`examples/deploy/`:**
- Purpose: Production VPS topology — Caddy + auth-gate + webtop on a private compose network.
- Contains: `compose.yml` (three services on an `edge` bridge network with named volumes `webtop-config`, `caddy-data`, `caddy-config`), `Caddyfile` (TLS, HSTS, reverse_proxy with `X-Forwarded-*`), `.env.example` (`DOMAIN`, `LETSENCRYPT_EMAIL`, `TZ`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ALLOWED_EMAILS`, `ALLOWED_USER_IDS`), `webtop.service` (systemd unit).

**`.github/`:**
- Purpose: GitHub-side project hygiene — issue/PR templates and LSIO's shared workflows for upstream-trigger builds and issue tracking.

**`.planning/codebase/`:**
- Purpose: GSD codebase maps consumed by downstream planning commands.
- Committed: Yes.
- Generated: Yes, by `/gsd-map-codebase` and its sub-agents.

## Key File Locations

**Image build:**
- `/home/nc773/docker-webtop-tribe/Dockerfile` — x86_64 multi-stage build (hermes-builder + LSIO selkies final). EXPOSE 3001, VOLUME `/config`, STOPSIGNAL SIGRTMIN+3, HEALTHCHECK on port 3001.
- `/home/nc773/docker-webtop-tribe/Dockerfile.aarch64` — aarch64 variant.
- `/home/nc773/docker-webtop-tribe/package_versions.txt` — bot-maintained apk pin list.

**Runtime config (container-side):**
- `/home/nc773/docker-webtop-tribe/root/defaults/startwm.sh` — X11 XFCE launcher.
- `/home/nc773/docker-webtop-tribe/root/defaults/startwm_wayland.sh` — Wayland launcher (Xwayland :1 first).
- `/home/nc773/docker-webtop-tribe/root/defaults/xfce/xfce4-panel.xml`, `xfce4-desktop.xml`, `xfwm4.xml`, `xsettings.xml` — XFCE defaults.
- `/home/nc773/docker-webtop-tribe/root/etc/s6-overlay/s6-rc.d/init-enterprise/run` — enterprise user setup oneshot.
- `/home/nc773/docker-webtop-tribe/root/etc/s6-overlay/s6-rc.d/init-enterprise/dependencies.d/init-adduser` — ordering marker.
- `/home/nc773/docker-webtop-tribe/root/etc/s6-overlay/s6-rc.d/user/contents.d/init-enterprise` — bundle registration.
- `/home/nc773/docker-webtop-tribe/root/usr/share/applications/hermes.desktop`, `/home/nc773/docker-webtop-tribe/root/etc/xdg/autostart/hermes.desktop` — hermes launcher/autostart.

**Application shims:**
- `/home/nc773/docker-webtop-tribe/root/usr/bin/chromium`
- `/home/nc773/docker-webtop-tribe/root/usr/bin/chromium-browser`
- `/home/nc773/docker-webtop-tribe/root/usr/bin/thunar`

**Auth gate:**
- `/home/nc773/docker-webtop-tribe/auth-gate/server.ts` — Bun.serve HTTP + WS proxy, Clerk verify, allow-lists, FORCE_HTTPS redirect, sign-in page.
- `/home/nc773/docker-webtop-tribe/auth-gate/Dockerfile` — multi-stage `bun:1-alpine` build.
- `/home/nc773/docker-webtop-tribe/auth-gate/package.json` — `@clerk/backend` dep and bun run scripts.
- `/home/nc773/docker-webtop-tribe/auth-gate/tsconfig.json`
- `/home/nc773/docker-webtop-tribe/auth-gate/.dockerignore`

**Deployment:**
- `/home/nc773/docker-webtop-tribe/examples/deploy/compose.yml` — three-service topology (webtop, auth-gate, caddy) on the `edge` network.
- `/home/nc773/docker-webtop-tribe/examples/deploy/Caddyfile` — TLS, HSTS, `reverse_proxy auth-gate:8080`.
- `/home/nc773/docker-webtop-tribe/examples/deploy/.env.example` — required deploy env vars.
- `/home/nc773/docker-webtop-tribe/examples/deploy/webtop.service` — systemd unit wrapper.
- `/home/nc773/docker-webtop-tribe/examples/podman-run.sh` — imperative rootless podman quickstart.
- `/home/nc773/docker-webtop-tribe/examples/webtop.container`, `/home/nc773/docker-webtop-tribe/examples/webtop-config.volume` — Podman Quadlet units.

**CI:**
- `/home/nc773/docker-webtop-tribe/Jenkinsfile`, `/home/nc773/docker-webtop-tribe/jenkins-vars.yml` — LSIO pipeline.
- `/home/nc773/docker-webtop-tribe/readme-vars.yml` — README template source.

**Not in repo but referenced at runtime:**
- `/usr/share/selkies/www/icon.png` — overwritten at build time with the webtop logo.
- `/usr/bin/thunar-real` — created by the Dockerfile's `mv` step so the shim can own the `thunar` name.
- `/usr/lib/chromium/chromium-launcher.sh` — Alpine's Chromium launcher, called directly by `root/usr/bin/chromium-browser`.
- `/opt/hermes/` — Python venv COPYed from the hermes-builder stage.

## Naming Conventions

**Files under `root/`:** Absolute container path mirrored verbatim. A file intended to live at `/defaults/startwm.sh` is stored at `root/defaults/startwm.sh`. No renaming, no templating.

**Dockerfiles:** `Dockerfile` for the default (amd64) build, `Dockerfile.<arch>` for additional architectures, `<component>/Dockerfile` for sidecar images (e.g. `auth-gate/Dockerfile`). Matches the LSIO convention consumed by `Jenkinsfile`.

**Shell scripts:** Lowercase, hyphen-free names matching the binary or hook they replace (`startwm.sh`, `chromium`, `thunar`). No extensions on PATH shims so they transparently shadow Alpine binaries.

**Config seed files:** XFCE channel name, lowercased, `.xml` extension, matching xfconf's own filenames under `xfce-perchannel-xml/`.

**s6 service files:** Fixed names (`run`, `type`, `up`, `finish`, `dependencies.d/<svc>`, `contents.d/<svc>`). Service directories use lowercase-dashed names (`init-enterprise`, `init-adduser`).

**TypeScript:** Lowercase camelCase file names (`server.ts`).

**Compose:** `compose.yml` (not the legacy `docker-compose.yml`).

**Env samples:** `.env.example` at each level that needs its own set (`/.env.example` for image build knobs, `examples/deploy/.env.example` for deploy vars).

## Import Path / Reference Patterns

**Inside the image:** Paths under `root/` map 1:1 to `/`. An s6 service at `root/etc/s6-overlay/s6-rc.d/init-enterprise/run` runs as `/etc/s6-overlay/s6-rc.d/init-enterprise/run`.

**Between containers:** Services reach each other by compose service name on the `edge` network — `http://webtop:3001` and `auth-gate:8080`. Never use `localhost` for cross-container traffic.

**Auth-gate -> upstream:** Configured via `UPSTREAM` env var (default `http://webtop:3001`), parsed once into HTTP origin and WS URL (`ws://webtop:3001`).

## Where to Add New Code

**New s6 service in webtop:**
- Create `root/etc/s6-overlay/s6-rc.d/<svc>/` with `type` (usually `oneshot` or `longrun`), `run`, and any `dependencies.d/<prereq>` markers.
- Register in the user bundle: touch `root/etc/s6-overlay/s6-rc.d/user/contents.d/<svc>`.
- Reference: `root/etc/s6-overlay/s6-rc.d/init-enterprise/` is the canonical in-repo example.

**New XFCE app launcher:**
- Desktop entry: `root/usr/share/applications/<app>.desktop`.
- Autostart (if needed): `root/etc/xdg/autostart/<app>.desktop`.
- Reference: `hermes.desktop` in both locations.

**New binary wrapper / PATH shim:**
- Drop a bash script at `root/usr/bin/<name>` (executable). If you need the original binary, add a rename step to both Dockerfiles (e.g. `mv /usr/bin/<name> /usr/bin/<name>-real`) and call `<name>-real` from the shim. Follow the pattern in `root/usr/bin/thunar`.

**New Alpine package in webtop:**
- Add to the `apk add --no-cache` list in `Dockerfile` (and `Dockerfile.aarch64` if arch-relevant), keep alphabetized. If the package ships an inappropriate autostart entry, remove it in the same `RUN` block. For ad-hoc inclusion at build time, pass via the `EXTRA_PACKAGES` build ARG.

**New XFCE default setting:**
- Edit the relevant file under `root/defaults/xfce/`. Existing users will NOT pick up the change because `startwm.sh` only seeds when `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml` does not exist — document upgrade behavior if the change is important.

**New session-startup behavior:**
- Edit `root/defaults/startwm.sh` (and `root/defaults/startwm_wayland.sh` if it must apply in Wayland mode). Keep the final command an `exec` so s6 supervises the real DE process.

**New auth-gate feature:**
- Edit `auth-gate/server.ts` — the whole gate is a single file by design. Add deps to `auth-gate/package.json`.
- New env knobs: read via `Bun.env.<NAME>` at the top of `server.ts` with a default, and document in `examples/deploy/.env.example` and `examples/deploy/compose.yml` `environment:` block.

**New deployment example:**
- Add under `examples/` (standalone recipe) or `examples/deploy/` (part of the full production topology).

**Hermes builder changes:**
- Edit the `hermes-builder` stage of `Dockerfile`. Runtime deps (`libffi`, `openssl`, `libstdc++`, `python3`, `git`) go in the final stage's hermes block; build deps (`rust`, `cargo`, `build-base`, `python3-dev`, `libffi-dev`, `openssl-dev`) stay in the builder stage only.

**New arch support:**
- Add a `Dockerfile.<arch>` mirroring the existing two and update `Jenkinsfile` / `jenkins-vars.yml` as the LSIO pipeline expects.

## Special Directories

**`root/`:**
- Purpose: Docker overlay source. Everything here ends up at `/` in the image.
- Generated: No — hand-maintained.
- Committed: Yes.

**`auth-gate/node_modules/`:**
- Purpose: Bun dependencies.
- Generated: Yes (during image build inside the Dockerfile).
- Committed: No (covered by `.dockerignore`).

**`examples/deploy/`:**
- Purpose: Reference production topology. Not referenced by the image build; users clone the repo and run compose from here.
- Generated: No.
- Committed: Yes.

**`/config` (runtime only, not in repo):**
- Purpose: Declared `VOLUME` in the Dockerfile. Holds the `abc` user's HOME including the xfconf files seeded from `root/defaults/xfce/`. Backed by the `webtop-config` named volume in compose.
- Generated: At runtime on first launch.

**`.planning/codebase/`:**
- Purpose: GSD codebase maps (this directory).
- Generated: Yes, by `/gsd-map-codebase`.
- Committed: Yes.

---

*Structure analysis: 2026-04-13*

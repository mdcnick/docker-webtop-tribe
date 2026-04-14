# Architecture

**Analysis Date:** 2026-04-13

## Pattern Overview

**Overall:** Layered Docker image overlay on top of a LinuxServer.io base image. This repository does not ship application source code; it composes a runtime by (1) selecting a base image, (2) installing Alpine packages, and (3) dropping a filesystem overlay (`root/`) that the base image's s6-overlay init picks up at container start.

**Key Characteristics:**
- Thin build: a single `Dockerfile` (amd64) and `Dockerfile.aarch64` (arm64) add XFCE + apps to `ghcr.io/linuxserver/baseimage-selkies:alpine323`.
- Runtime behavior is inherited from the Selkies base image (s6-overlay services, Selkies WebRTC gateway, web UI, PulseAudio, DBus, Xvfb/Xwayland wiring). This repo only overrides the X session entrypoint and XFCE defaults.
- User interaction path is browser-based: HTTP/WebSocket on port 3001 into Selkies, which streams the XFCE desktop via WebRTC.
- Single-user desktop model: `/config` is the persistent HOME for the abc user provided by the base image.

## Layers

**Base image layer (inherited, not in repo):**
- Purpose: Provides s6-overlay init, the `abc` user, Selkies WebRTC gateway + web frontend at `/usr/share/selkies/www`, Xvfb/Xwayland, PulseAudio, OpenBox fallback, and the `/defaults/startwm.sh` hook contract.
- Source: `ghcr.io/linuxserver/baseimage-selkies:alpine323` (referenced in `Dockerfile` line 3 and `Dockerfile.aarch64`).
- Exposes a convention: whatever `/defaults/startwm.sh` execs becomes the desktop session run inside the Selkies X/Wayland display.

**Package layer (this repo, build-time):**
- Purpose: Installs the Alpine XFCE desktop and user-facing apps.
- Location: `Dockerfile` lines 15-42 (`apk add xfce4 xfce4-terminal chromium mousepad ristretto thunar` plus `adw-gtk3`, `adwaita-xfce-icon-theme`, `util-linux-misc`).
- Post-install mutations:
  - `mv /usr/bin/thunar /usr/bin/thunar-real` so the overlay shim can take the `thunar` name.
  - Removes `xfce4-power-manager` and `xscreensaver` autostart entries and the power-manager panel plugin (irrelevant inside a container).
  - Replaces `/usr/share/selkies/www/icon.png` with the webtop logo to brand the web UI.
  - Clears `/config/.cache` and `/tmp/*`.

**Overlay layer (this repo, `root/`):**
- Purpose: Session entrypoint scripts, XFCE default configuration, and binary wrappers that interpose on user-facing commands.
- Location: `root/` (COPYed at `Dockerfile` line 45 via `COPY /root /`).
- Contents:
  - `root/defaults/startwm.sh` - X11 session launcher invoked by the base image.
  - `root/defaults/startwm_wayland.sh` - Wayland variant that starts `Xwayland :1` before the XFCE session.
  - `root/defaults/xfce/*.xml` - xfconf seed files (`xfce4-panel.xml`, `xfce4-desktop.xml`, `xfwm4.xml`, `xsettings.xml`) copied into the user's home on first launch.
  - `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`, `root/usr/bin/thunar` - wrapper shims on `PATH`.

## Data Flow

**Container startup (s6-overlay, inherited):**

1. Docker runs the Selkies base entrypoint; s6-overlay brings up PID 1 supervision.
2. Base-image services start in order: DBus, PulseAudio, Xvfb (or Xwayland), the Selkies WebRTC gateway/HTTP server bound to port 3001, and finally the desktop service.
3. The desktop service execs `/defaults/startwm.sh` (X11) - or the Wayland equivalent - as the `abc` user with `HOME=/config`.
4. `startwm.sh` seeds `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml/` from `/defaults/xfce/*` on first run, then `exec dbus-launch --exit-with-session /usr/bin/xfce4-session`.
5. `xfce4-session` starts xfwm4, xfce4-panel, xfdesktop, xfsettingsd, Thunar daemon, etc., rendered onto the Selkies-managed display.

**User session (runtime, per browser client):**

1. Client loads `http://<host>:3001/`, served from `/usr/share/selkies/www` (branding replaced with `icon.png` from the Dockerfile).
2. Browser opens a WebSocket/WebRTC session to Selkies; Selkies captures the X/Wayland display and PulseAudio sink and streams video/audio.
3. Input events flow back through Selkies into the X server as synthetic input, driving the XFCE session.
4. Launcher clicks on Chromium/Thunar resolve via `PATH` to the overlay shims in `/usr/bin/`, not the Alpine binaries.

**Wayland mode (optional):**

1. `startwm_wayland.sh` sets `WAYLAND_DISPLAY=wayland-1`, backgrounds `Xwayland :1`, waits 2s, then launches the XFCE session the same way as the X11 path, allowing XFCE (an X11 DE) to run against Xwayland.

**Chromium launch:**

1. Desktop shortcut calls `chromium` - resolves to `root/usr/bin/chromium`.
2. Shim sets `GTK_THEME=Adwaita:light` (Alpine theme workaround), clears stale `~/.config/chromium/Singleton*` lock files.
3. Inspects `/proc/1/status` for `Seccomp: 0`:
   - Privileged container -> exec `/usr/bin/chromium-browser --no-first-run --password-store=basic`.
   - Unprivileged container -> append `--no-sandbox --test-type` to avoid the sandbox requiring kernel capabilities.
4. `root/usr/bin/chromium-browser` is a second shim that does the same logic but targets `/usr/lib/chromium/chromium-launcher.sh` directly (used when something bypasses `chromium` and calls `chromium-browser`).

**Thunar launch:**

1. Any caller of `thunar` resolves to `root/usr/bin/thunar`, which `unset LD_PRELOAD` and execs `thunar-real` (the relocated Alpine binary).
2. The `LD_PRELOAD` reset exists because the Selkies base image injects a preload library for display/input capture that interferes with Thunar; unsetting it lets Thunar run cleanly while the rest of the session keeps the preload.

## Key Abstractions

**Base image contract (`/defaults/startwm.sh`):**
- Purpose: Single hook the Selkies base image uses to launch "the desktop". Overriding this file is how any downstream image chooses its WM/DE.
- Examples: `root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`.
- Pattern: Script must `exec` the session and stay in the foreground so s6 can supervise it.

**xfconf seed (`/defaults/xfce/`):**
- Purpose: Deliver a branded, container-appropriate XFCE configuration on first launch without baking it into `/etc/skel`.
- Examples: `root/defaults/xfce/xfce4-panel.xml`, `root/defaults/xfce/xfce4-desktop.xml`, `root/defaults/xfce/xfwm4.xml`, `root/defaults/xfce/xsettings.xml`.
- Pattern: Copy-on-first-run guarded by the existence of `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml`, so user edits in `/config` survive container restarts and upgrades.

**PATH-shim wrapper:**
- Purpose: Interpose on a third-party binary to fix container-specific runtime issues without patching the upstream package.
- Examples: `root/usr/bin/chromium` (sandbox toggling), `root/usr/bin/chromium-browser` (same, direct launcher), `root/usr/bin/thunar` (LD_PRELOAD bypass).
- Pattern: Rename the real binary (`thunar -> thunar-real`) or target the upstream launcher path (`/usr/lib/chromium/chromium-launcher.sh`), then provide a bash shim earlier on `PATH`.

## Entry Points

**Container entrypoint:**
- Location: Inherited from `ghcr.io/linuxserver/baseimage-selkies:alpine323` (s6-overlay `/init`).
- Triggers: `docker run` / Compose start.
- Responsibilities: Bring up DBus, PulseAudio, Xvfb/Xwayland, Selkies gateway on :3001, then hand off to `/defaults/startwm.sh`.

**Desktop session entrypoint:**
- Location: `root/defaults/startwm.sh` (installed to `/defaults/startwm.sh`).
- Triggers: Selkies desktop service inside s6.
- Responsibilities: Seed xfconf on first run, exec `xfce4-session` under `dbus-launch`.

**Wayland desktop session entrypoint:**
- Location: `root/defaults/startwm_wayland.sh` (installed to `/defaults/startwm_wayland.sh`).
- Triggers: Selkies desktop service when the base image is configured for Wayland mode.
- Responsibilities: Start `Xwayland :1`, then exec the XFCE session.

**Web UI entrypoint:**
- Location: `/usr/share/selkies/www/` (from base image); only `icon.png` is overridden by this repo.
- Triggers: HTTP request to port 3001.
- Responsibilities: Serve the Selkies frontend that negotiates the WebRTC stream.

## Error Handling

**Strategy:** Container-idiomatic - scripts rely on `set`-less bash and let s6-overlay restart failed services. Wrappers prefer silent fallbacks (e.g., Chromium sandbox detection) over hard failures so the desktop still reaches the user.

**Patterns:**
- `startwm.sh` redirects `xfce4-session` stdio to `/dev/null` and relies on `exec` so s6 supervises the real DE process, not a shell.
- Chromium shims probe `/proc/1/status` at every launch to decide whether `--no-sandbox --test-type` is required, covering both privileged and unprivileged deployments without configuration.
- Stale singleton lockfiles under `~/.config/chromium/` are proactively deleted before launch to survive unclean container shutdowns.
- The xfconf seed is guarded by a directory-existence check so a user's edits in the persistent `/config` volume are never overwritten.

## Cross-Cutting Concerns

**Supervision:** s6-overlay from the base image supervises Selkies, Xvfb/Xwayland, PulseAudio, DBus, and the XFCE session launched via `startwm.sh`.

**Streaming transport:** Selkies (WebRTC) on TCP 3001 for both the HTTP frontend and the signaling/data channels. No VNC/NoVNC layer in this fork.

**Audio:** PulseAudio sink provided by the base image; XFCE apps route to it automatically via DBus.

**Persistence:** Single `VOLUME /config` declared in `Dockerfile` line 50. The `abc` user's `HOME` lives here, which is why xfconf seeding targets `${HOME}/.config/xfce4/...`.

**Theming:** `adw-gtk3` + `adwaita-xfce-icon-theme` packages plus `xsettings.xml` and a forced `GTK_THEME=Adwaita:light` env inside the Chromium shim to work around Alpine's Chromium GTK detection.

**Sandboxing:** Chromium shims auto-detect seccomp state to pick safe flags; no capability drops are hardcoded here.

**Multi-arch:** Parallel `Dockerfile` and `Dockerfile.aarch64` so Jenkins (`Jenkinsfile`, `jenkins-vars.yml`) can build an arm64 variant; both consume the same `root/` overlay.

---

*Architecture analysis: 2026-04-13*

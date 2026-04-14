# Codebase Structure

**Analysis Date:** 2026-04-13

## Directory Layout

```
docker-webtop-tribe/
├── Dockerfile                        # amd64 build (FROM baseimage-selkies:alpine323)
├── Dockerfile.aarch64                # arm64 build, same overlay
├── Jenkinsfile                       # LinuxServer.io CI pipeline
├── jenkins-vars.yml                  # Jenkins pipeline variables
├── readme-vars.yml                   # README template variables
├── package_versions.txt              # Captured apk versions per build (bot-updated)
├── README.md                         # Rendered readme
├── LICENSE                           # GPL (LinuxServer.io convention)
├── .editorconfig                     # Editor formatting
├── .gitignore
├── .github/                          # Issue/PR templates and automation
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   │   ├── config.yml
│   │   ├── issue.bug.yml
│   │   └── issue.feature.yml
│   └── workflows/                    # GitHub Actions (issue triage, triggers)
│       ├── call_issue_pr_tracker.yml
│       ├── call_issues_cron.yml
│       ├── external_trigger.yml
│       ├── external_trigger_scheduler.yml
│       ├── greetings.yml
│       ├── package_trigger_scheduler.yml
│       └── permissions.yml
└── root/                             # Filesystem overlay COPYed to / at build time
    ├── defaults/
    │   ├── startwm.sh                # X11 XFCE session entrypoint (exec'd by base image)
    │   ├── startwm_wayland.sh        # Wayland variant (starts Xwayland :1 first)
    │   └── xfce/                     # xfconf seed copied into ${HOME} on first launch
    │       ├── xfce4-desktop.xml
    │       ├── xfce4-panel.xml
    │       ├── xfwm4.xml
    │       └── xsettings.xml
    └── usr/
        └── bin/                      # PATH shims that override Alpine binaries
            ├── chromium              # Sandbox-aware Chromium launcher
            ├── chromium-browser      # Same logic, targets chromium-launcher.sh
            └── thunar                # Unsets LD_PRELOAD, execs thunar-real
```

## Directory Purposes

**Repository root:**
- Purpose: Build definitions and project metadata. No application source.
- Contains: `Dockerfile`, `Dockerfile.aarch64`, `Jenkinsfile`, YAML config, readme/license.
- Key files: `Dockerfile`, `Dockerfile.aarch64`, `Jenkinsfile`, `jenkins-vars.yml`, `readme-vars.yml`, `package_versions.txt`.

**`.github/`:**
- Purpose: GitHub-side project hygiene - issue/PR templates and LinuxServer.io's shared workflows for upstream-trigger builds and issue tracking.
- Contains: Templates and Actions workflows.
- Key files: `.github/workflows/external_trigger.yml`, `.github/workflows/package_trigger_scheduler.yml`.

**`root/`:**
- Purpose: Filesystem overlay. Everything under `root/` is copied to `/` inside the image via `COPY /root /` in the `Dockerfile`. Path layout mirrors the final container paths.
- Contains: Session entrypoint scripts, XFCE xfconf defaults, and `/usr/bin` shims.
- Key files: `root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`.

**`root/defaults/`:**
- Purpose: Installed to `/defaults/` - the LinuxServer.io convention for image-shipped config that gets copied into the user's HOME on first run. The Selkies base image execs `/defaults/startwm.sh` to start the desktop.
- Contains: Session launch scripts and the `xfce/` seed directory.
- Key files: `root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`.

**`root/defaults/xfce/`:**
- Purpose: xfconf channel XML files seeded into `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml/` on first launch (guarded by a directory-existence check in `startwm.sh`).
- Contains: Four xfconf channels: panel layout, desktop/wallpaper, window manager, and xsettings (theme, icons, fonts).
- Key files: `root/defaults/xfce/xfce4-panel.xml`, `root/defaults/xfce/xsettings.xml`.

**`root/usr/bin/`:**
- Purpose: Binary-name shims that take precedence over Alpine-provided binaries on `PATH` to fix container-specific quirks (Chromium sandbox/GTK, Thunar LD_PRELOAD).
- Contains: Three bash scripts.
- Key files: `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`, `root/usr/bin/thunar`. Note that `root/usr/bin/thunar` depends on the Dockerfile having renamed the real binary to `/usr/bin/thunar-real`.

## Key File Locations

**Build definitions:**
- `/home/nc773/docker-webtop-tribe/Dockerfile`: amd64 image - installs xfce4, chromium, mousepad, ristretto, thunar, xfce4-terminal; renames thunar; strips power/screensaver autostarts; COPYs `root/`; EXPOSE 3001; VOLUME `/config`.
- `/home/nc773/docker-webtop-tribe/Dockerfile.aarch64`: arm64 equivalent.

**CI / release:**
- `/home/nc773/docker-webtop-tribe/Jenkinsfile`: LinuxServer.io shared pipeline driver.
- `/home/nc773/docker-webtop-tribe/jenkins-vars.yml`: Per-image pipeline variables.
- `/home/nc773/docker-webtop-tribe/package_versions.txt`: Bot-maintained apk version snapshot (see recent "Bot Updating Package Versions" commits).
- `/home/nc773/docker-webtop-tribe/readme-vars.yml`: Inputs for the generated README.

**Session entrypoints:**
- `/home/nc773/docker-webtop-tribe/root/defaults/startwm.sh`: X11 XFCE launcher.
- `/home/nc773/docker-webtop-tribe/root/defaults/startwm_wayland.sh`: Wayland/Xwayland XFCE launcher.

**XFCE defaults:**
- `/home/nc773/docker-webtop-tribe/root/defaults/xfce/xfce4-panel.xml`
- `/home/nc773/docker-webtop-tribe/root/defaults/xfce/xfce4-desktop.xml`
- `/home/nc773/docker-webtop-tribe/root/defaults/xfce/xfwm4.xml`
- `/home/nc773/docker-webtop-tribe/root/defaults/xfce/xsettings.xml`

**Application shims:**
- `/home/nc773/docker-webtop-tribe/root/usr/bin/chromium`
- `/home/nc773/docker-webtop-tribe/root/usr/bin/chromium-browser`
- `/home/nc773/docker-webtop-tribe/root/usr/bin/thunar`

**Not in repo but referenced at runtime:**
- `/usr/share/selkies/www/icon.png` - overwritten at build time with the webtop logo (`Dockerfile` lines 17-19).
- `/usr/bin/thunar-real` - created by the Dockerfile's `mv` step so the shim can own the `thunar` name.
- `/usr/lib/chromium/chromium-launcher.sh` - Alpine's Chromium launcher, called directly by `root/usr/bin/chromium-browser`.

## Naming Conventions

**Files under `root/`:**
- Absolute container path mirrored verbatim. A file intended to live at `/defaults/startwm.sh` is stored at `root/defaults/startwm.sh`. No renaming, no templating.

**Dockerfiles:**
- `Dockerfile` for the default (amd64) build, `Dockerfile.<arch>` for additional architectures. Matches the LinuxServer.io convention consumed by `Jenkinsfile`.

**Shell scripts:**
- Lowercase, hyphen-free names matching the binary or hook they replace (`startwm.sh`, `chromium`, `thunar`). Shebang is `#!/bin/bash` (or `#! /bin/bash`). No extensions on PATH shims so they transparently shadow the Alpine binaries.

**Config seed files:**
- XFCE channel name, lowercased, `.xml` extension: `xfce4-panel.xml`, `xfwm4.xml`, `xsettings.xml`, `xfce4-desktop.xml`. Matches the filenames xfconf itself writes under `xfce-perchannel-xml/`.

## Where to Add New Code

**New Alpine package in the desktop:**
- Add to the `apk add --no-cache` list in `Dockerfile` (lines 21-30) AND `Dockerfile.aarch64`. Keep the list alphabetized. If the package ships an autostart entry that is inappropriate for containers (screensaver, power manager, update notifier), remove it in the same `RUN` block alongside the existing `rm -f /etc/xdg/autostart/...` lines.

**New XFCE default setting:**
- Edit the relevant file under `root/defaults/xfce/` (`xfce4-panel.xml` for panel layout, `xsettings.xml` for theme/fonts, `xfwm4.xml` for window manager, `xfce4-desktop.xml` for wallpaper/desktop icons). Existing users will NOT pick up the change because `startwm.sh` only seeds when `${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml` does not exist - document upgrade behavior if the change is important.

**New session-startup behavior:**
- Edit `root/defaults/startwm.sh` (and `root/defaults/startwm_wayland.sh` if it must also apply in Wayland mode). Keep the final command an `exec` so s6-overlay supervises the real DE process.

**New PATH shim / binary override:**
- Drop a bash script at `root/usr/bin/<name>` (executable, `#!/bin/bash`). If you need the original binary, add a rename step to both Dockerfiles (e.g., `mv /usr/bin/<name> /usr/bin/<name>-real`) and call `<name>-real` from the shim. Follow the pattern in `root/usr/bin/thunar`.

**New file anywhere else in the image:**
- Create the path under `root/` mirroring the absolute container path. No Dockerfile edit is required - the existing `COPY /root /` picks it up. Ensure executables have the executable bit set in git.

**New arch support:**
- Add a `Dockerfile.<arch>` mirroring the existing two and update `Jenkinsfile` / `jenkins-vars.yml` as the LinuxServer.io pipeline expects.

## Special Directories

**`.planning/`:**
- Purpose: GSD planning workspace (this audit lives under `.planning/codebase/`).
- Generated: Yes (by GSD tooling).
- Committed: Optional - not required for the image build.

**`root/`:**
- Purpose: Docker overlay source. Everything here ends up at `/` in the image.
- Generated: No - hand-maintained.
- Committed: Yes.

**`/config` (runtime only, not in repo):**
- Purpose: Declared `VOLUME` in the Dockerfile. Holds the `abc` user's HOME including the xfconf files seeded from `root/defaults/xfce/`.
- Generated: At runtime on first launch.
- Committed: N/A.

---

*Structure analysis: 2026-04-13*

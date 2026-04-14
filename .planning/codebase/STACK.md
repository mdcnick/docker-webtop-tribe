# Technology Stack

**Analysis Date:** 2026-04-13

## Languages

**Primary:**
- Dockerfile - Image build definitions (`Dockerfile`, `Dockerfile.aarch64`)
- Shell (POSIX/ash) - Runtime launch scripts (`root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`, `root/usr/bin/chromium`, `root/usr/bin/chromium-browser`, `root/usr/bin/thunar`)
- Groovy - Jenkins pipeline (`Jenkinsfile`)
- YAML - CI and README metadata (`jenkins-vars.yml`, `readme-vars.yml`, `.github/workflows/*`)
- XML - XFCE xfconf defaults (`root/defaults/xfce/*.xml`)

**Secondary:**
- Markdown - Docs (`README.md`, `.github/*.md`) — README is generated from `readme-vars.yml`

## Runtime

**Environment:**
- Base image: `ghcr.io/linuxserver/baseimage-selkies:alpine323` (x86_64)
- Base image: `ghcr.io/linuxserver/baseimage-selkies:arm64v8-alpine323` (aarch64)
- Distro: Alpine Linux 3.23.3 (see `package_versions.txt`)
- Init system: s6-overlay (inherited from LinuxServer baseimage)
- Display stack: Selkies (WebRTC remote desktop) inherited from base

**Package Manager:**
- `apk` (Alpine package keeper) — used in Dockerfile `RUN apk add --no-cache ...`
- No application-level package manager; no lockfile (image is the artifact)

## Frameworks

**Core:**
- LinuxServer.io Selkies baseimage - Provides Selkies-GStreamer WebRTC streaming, nginx, s6, abc user, `/config` volume conventions
- XFCE4 desktop environment - Installed via `xfce4`, `xfce4-terminal` apk packages

**Testing:**
- LinuxServer CI harness - Configured in `jenkins-vars.yml` (`CI`, `CI_WEB`, `CI_PORT=3001`, `CI_SSL=true`, `CI_DELAY=60`, `CI_WEB_SCREENSHOT_DELAY=10`). Runs container, screenshots web UI, uploads to S3.

**Build/Dev:**
- Docker Buildx (multi-arch via `docker/dockerfile:1` syntax directive)
- Jenkins - Pipeline in `Jenkinsfile` orchestrates build, tag, scan, push, release
- GitHub Actions - `.github/workflows/` (issue/PR automation)

## Key Dependencies

**Desktop environment (apk, installed in Dockerfile):**
- `xfce4` - Core XFCE meta-package
- `xfce4-terminal` - Terminal emulator
- `adw-gtk3` - Adwaita GTK3 theme
- `adwaita-xfce-icon-theme` - Icon theme
- `chromium` - Default browser (wrapped by `root/usr/bin/chromium`)
- `thunar` - File manager (real binary moved to `thunar-real`, wrapper at `root/usr/bin/thunar`)
- `mousepad` - Text editor
- `ristretto` - Image viewer
- `util-linux-misc` - Misc utilities

**Infrastructure (inherited from baseimage-selkies):**
- `selkies` / selkies-gstreamer - WebRTC remote desktop streaming (icon path `/usr/share/selkies/www/icon.png`)
- `nginx` - HTTP/HTTPS reverse proxy for web UI
- `s6-overlay` - Process supervision / init
- Python runtime - Used by selkies (see `aiohttp`, `aiofiles`, `aioice` entries in `package_versions.txt`)

## Configuration

**Environment:**
- `TITLE=Alpine XFCE` (set in Dockerfile)
- `TZ` - Timezone (LinuxServer convention; CI uses `TZ=US/Pacific`)
- `PUID`/`PGID` - User mapping (LinuxServer baseimage convention)
- `CUSTOM_USER` / `PASSWORD` - Selkies basic auth (baseimage convention)
- Build args: `BUILD_DATE`, `VERSION`, `XFCE_VERSION`
- No `.env` files present

**Build:**
- `Dockerfile` - x86_64 build
- `Dockerfile.aarch64` - arm64 build
- `Jenkinsfile` - Full CI/CD pipeline (~65 KB)
- `jenkins-vars.yml` - Per-repo Jenkins variables
- `readme-vars.yml` - Template variables for README generation
- `.editorconfig` - Editor formatting rules

## Platform Requirements

**Development:**
- Docker with Buildx (multi-arch builds)
- For local testing: `docker run` with `--shm-size=1gb` (per `readme-vars.yml` custom_params)

**Production:**
- Any Docker/OCI host (linux/amd64 or linux/arm64)
- Published ports: `3000` (HTTP, must be proxied) and `3001` (HTTPS)
- Volume: `/config` (abc user home directory)
- Recommended: `--shm-size=1gb`, optional NVIDIA GPU passthrough (`show_nvidia: true` in `readme-vars.yml`)

## Build Artifacts

- `package_versions.txt` - Bot-maintained SBOM-like listing of apk/python/rust-crate versions inside the built image (184 KB)
- `README.md` - Bot-generated from `readme-vars.yml` via LinuxServer templating

---

*Stack analysis: 2026-04-13*

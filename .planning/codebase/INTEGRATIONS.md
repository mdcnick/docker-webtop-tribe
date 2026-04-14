# External Integrations

**Analysis Date:** 2026-04-13

## APIs & External Services

**Container registries (pull):**
- `ghcr.io/linuxserver/baseimage-selkies` - Upstream base image referenced by both `Dockerfile` and `Dockerfile.aarch64` (tags `alpine323`, `arm64v8-alpine323`)

**Container registries (push, via `Jenkinsfile` / `jenkins-vars.yml`):**
- Docker Hub - `linuxserver/webtop` (release), `lsiodev/webtop` (dev), `lspipepr/webtop` (PR)
- GitHub Container Registry (ghcr.io) - Mirror of the above (LinuxServer convention)
- Quay.io - Mirror (LinuxServer convention)

**Asset downloads (build time):**
- `raw.githubusercontent.com/linuxserver/docker-templates/.../webtop-logo.png` - Fetched via `curl` in Dockerfile, written to `/usr/share/selkies/www/icon.png`

## Data Storage

**Databases:**
- None

**File Storage:**
- Local filesystem only - `/config` volume (abc user home directory, declared `VOLUME /config` in Dockerfile)

**Caching:**
- None at application level; build-time `/config/.cache` is purged in Dockerfile

## Authentication & Identity

**Auth Provider:**
- Selkies built-in basic auth (inherited from `baseimage-selkies`)
  - Configured via `CUSTOM_USER` / `PASSWORD` environment variables
  - CI credential: `user:password` (`CI_AUTH` in `jenkins-vars.yml`)
- LinuxServer `abc` user model - PUID/PGID mapping handled by s6 init scripts from the baseimage

## Monitoring & Observability

**Error Tracking:**
- None

**Logs:**
- Container stdout/stderr via s6-overlay (baseimage default)
- No application log aggregation

## CI/CD & Deployment

**Hosting:**
- End users self-host the Docker image

**CI Pipeline:**
- Jenkins - Primary pipeline (`Jenkinsfile`, ~65 KB)
  - Builds x86_64 and arm64 images, creates manifest
  - Runs LinuxServer CI container test (boots image, screenshots web UI on port 3001 over SSL after 60 s)
  - Pushes to Docker Hub, GHCR, Quay
  - Updates `README.md` from `readme-vars.yml`
  - Updates `package_versions.txt` via bot commit
- GitHub Actions - `.github/workflows/` handles issue/PR triage and external trigger hooks
- Bot commits visible in git log: "Bot Updating Package Versions", "Bot Updating Templated Files"

**Multi-arch:**
- `MULTIARCH = 'true'` in `jenkins-vars.yml`
- Separate Dockerfiles per arch combined into a manifest list by Jenkins

## Environment Configuration

**Required env vars (runtime):**
- `PUID`, `PGID` - User/group mapping (LinuxServer convention)
- `TZ` - Timezone
- `CUSTOM_USER`, `PASSWORD` - Selkies basic auth (optional but recommended)
- `TITLE` - Window title (defaults to `Alpine XFCE` in Dockerfile)

**Build args:**
- `BUILD_DATE`, `VERSION`, `XFCE_VERSION` (XFCE_VERSION is the `BUILD_VERSION_ARG` per `jenkins-vars.yml`)

**Secrets location:**
- Jenkins credentials store (not in repo)
- No `.env*` files in repository

## Webhooks & Callbacks

**Incoming:**
- Jenkins webhook triggers on:
  - GitHub push to `master`
  - Upstream baseimage updates (external trigger configured in Jenkins)

**Outgoing:**
- Jenkins pushes images to registries after successful build
- Jenkins commits `README.md` and `package_versions.txt` back to the repo

## Host Integration (runtime)

**Ports exposed:**
- `3000/tcp` - HTTP web desktop (must be reverse-proxied for auth/TLS)
- `3001/tcp` - HTTPS web desktop (self-signed)

**Host resources:**
- `/dev/dri` - Optional for GPU acceleration (Selkies baseimage feature)
- NVIDIA GPU - Supported (`show_nvidia: true` in `readme-vars.yml`)
- `--shm-size=1gb` - Recommended for Chromium inside the desktop

**Wrapper shims (`root/usr/bin/`):**
- `chromium`, `chromium-browser` - Wrap the apk chromium binary to inject sandbox/flag overrides suitable for containerized rootless execution
- `thunar` - Wraps `thunar-real` (renamed in Dockerfile) so Thunar launches correctly inside the Selkies session

---

*Integration audit: 2026-04-13*

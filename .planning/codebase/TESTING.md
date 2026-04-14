# Testing Patterns

**Analysis Date:** 2026-04-13

## Overview

**There is no unit test suite in this repository.** This is a LinuxServer.io Docker packaging repo — "testing" means building the image and smoke-testing the running container via the LSIO shared Jenkins pipeline. Quality is enforced entirely by CI; there is nothing to run locally beyond `docker build`.

## Test Framework

**Runner:** LSIO shared Jenkins pipeline (`Jenkinsfile`)

**Config sources:**
- `Jenkinsfile` - pipeline steps (rarely edited)
- `jenkins-vars.yml` - per-repo knobs consumed by the LSIO jenkins-builder
- Environment block in `Jenkinsfile` defines the CI contract

**Assertion mechanism:** pipeline stage exit codes + container log/screenshot inspection.

## What "Testing" Means Here

The pipeline exercises three layers:

1. **Build test** - `docker build` succeeds for both `Dockerfile` (x86_64) and `Dockerfile.aarch64` (arm64) on the `X86-64-MULTI` agent. A broken `RUN` layer fails the build stage.
2. **Container smoke test** - the freshly built image is launched with the CI env vars below; the pipeline waits `CI_DELAY` seconds, then verifies the container is still running and the web UI is reachable.
3. **Web screenshot test** - a headless browser connects to `https://<container>:${CI_PORT}${CI_WEBPATH}` using `CI_AUTH`, waits `CI_WEB_SCREENSHOT_DELAY` seconds, and captures a screenshot that is uploaded as a build artifact for human review.

## CI Variables That Control Testing

Defined in `Jenkinsfile` / `jenkins-vars.yml`:

| Variable | Value | Purpose |
|---|---|---|
| `CI` | `true` | Enables CI test stages |
| `CI_WEB` | `true` | Run the web UI screenshot test |
| `CI_PORT` | `3001` | Selkies web port to probe |
| `CI_SSL` | `true` | Use HTTPS when probing |
| `CI_DELAY` | `60` | Seconds to wait after launch before probing |
| `CI_WEB_SCREENSHOT_DELAY` | `10` | Seconds to let the page render |
| `CI_DOCKERENV` | `TZ=US/Pacific` | Extra env vars passed to `docker run` |
| `CI_AUTH` | `user:password` | Basic-auth creds used for the web probe |
| `CI_WEBPATH` | `` (empty) | Sub-path the UI is served from |
| `MULTIARCH` | `true` | Build and test both x86_64 and aarch64 |
| `PACKAGE_CHECK` | `false` (param) | If `true`, only rebuild when upstream packages changed |

## Running Tests Locally

There is no `npm test` / `pytest` equivalent. To approximate CI locally:

```bash
# Build
docker build -t webtop-test .

# Smoke-test run (mirrors CI env)
docker run -d --name webtop-test \
  -e TZ=US/Pacific \
  -e CUSTOM_USER=user \
  -e PASSWORD=password \
  -p 3001:3001 \
  webtop-test

# Wait, then probe
sleep 60
curl -k -u user:password https://localhost:3001/ -o /dev/null -w '%{http_code}\n'
docker logs webtop-test
docker rm -f webtop-test
```

For aarch64, repeat with `Dockerfile.aarch64` on an arm64 host or under `buildx --platform linux/arm64`.

## Package Version Checks

- The pipeline can be triggered with `PACKAGE_CHECK=true`. It rebuilds, diffs installed packages against `package_versions.txt`, and — if different — the `jenkins-builder` bot commits an updated `package_versions.txt` with message `Bot Updating Package Versions`.
- Treat `package_versions.txt` as an output of the test pipeline, not an input.

## Template Drift Checks

- The pipeline also regenerates `README.md` from `readme-vars.yml` and the LSIO shared templates. If the working tree would change, the bot commits `Bot Updating Templated Files`.
- A PR whose only diff after CI is a bot templated-files commit is expected; do not revert it.

## Shell / Dockerfile Linting

- No `shellcheck` or `hadolint` config is committed. LSIO CI may run them centrally; locally, running `shellcheck root/defaults/startwm.sh root/usr/bin/chromium` and `hadolint Dockerfile Dockerfile.aarch64` is recommended before opening a PR.

## Coverage

**Not applicable.** There is no code coverage metric. Effective coverage is:
- Every line of `Dockerfile` is exercised by the build stage.
- `root/defaults/startwm.sh` and XFCE default XMLs are exercised on first container launch during the smoke test.
- Wrapper scripts in `root/usr/bin/` are only exercised if the screenshot test happens to launch them (chromium typically is, via the XFCE session).

## Test Gaps / Risk Areas

- **Wrapper scripts** (`root/usr/bin/chromium`, `thunar`) are only indirectly validated; a syntax error survives unless the wrapped app is actually launched during the screenshot window.
- **aarch64 parity** depends on `Dockerfile.aarch64` being edited in lockstep; there is no automated diff check between the two Dockerfiles.
- **First-run defaults** in `root/defaults/xfce/*.xml` are not schema-validated; malformed XML only surfaces as a broken desktop in the screenshot.
- **No negative tests** — nothing verifies that removing e.g. `--no-sandbox` fallback correctly breaks in an unprivileged container.

## Common Patterns

**Adding a new packaged application:**
1. Add the package to the `apk add --no-cache` block in *both* Dockerfiles.
2. If it needs a wrapper, add it under `root/usr/bin/` and rename the real binary in the Dockerfile cleanup section.
3. Push a PR; rely on the Jenkins screenshot artifact to confirm the desktop still renders.

**Changing XFCE defaults:**
1. Edit the XML under `root/defaults/xfce/`.
2. CI screenshot will show the new default after a clean `/config`.

---

*Testing analysis: 2026-04-13*

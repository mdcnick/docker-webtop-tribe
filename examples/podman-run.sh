#!/usr/bin/env bash
# Run webtop-tribe under rootless podman.
#
# LSIO images MUST boot as uid 0 inside the container so s6-overlay can
# chown /config, write /etc/nginx conf, etc., before dropping to abc. Under
# rootless podman the ONLY way to get that is the default userns (no
# --userns=keep-id): podman starts the container as uid 0 inside, which
# maps to your real host user via /etc/subuid. Anything else breaks
# init-nginx, init-selkies, and the PUID/PGID remap.
#
# Because we don't use keep-id, the abc user inside (uid 1000) maps to a
# high subuid on the host (e.g. 100999). To keep host-side ownership sane
# we use a named podman VOLUME for /config instead of a bind mount — the
# uid lives inside the userns and you never see it on the host. If you
# want a bind mount instead, set CONFIG_DIR to a path and be prepared for
# `ls -l` to show a weird owner.
#
# Other flags:
#   --shm-size=1g    chromium crashes with the default 64MB shm
#   --security-opt seccomp=unconfined
#                    chromium's sandbox needs syscalls podman blocks by
#                    default (drop if you build with INCLUDE_CHROMIUM=false)
#   --stop-signal SIGRTMIN+3  matches image STOPSIGNAL for clean s6 shutdown

set -euo pipefail

IMAGE="${IMAGE:-localhost/webtop-tribe:latest}"
NAME="${NAME:-webtop}"
PORT="${PORT:-3001}"
CONFIG_VOLUME="${CONFIG_VOLUME:-webtop-config}"

podman volume exists "${CONFIG_VOLUME}" || podman volume create "${CONFIG_VOLUME}" >/dev/null

exec podman run -d \
  --name "${NAME}" \
  --security-opt seccomp=unconfined \
  --shm-size=1g \
  --stop-signal SIGRTMIN+3 \
  --stop-timeout 30 \
  -p "${PORT}:3001" \
  -v "${CONFIG_VOLUME}:/config" \
  -e PUID=1000 \
  -e PGID=1000 \
  -e UMASK=027 \
  -e TZ=Etc/UTC \
  -e ENTERPRISE_FULLNAME="Corp User" \
  -e ENTERPRISE_GROUPS="devs:1001" \
  -e ENTERPRISE_SUDO=false \
  "${IMAGE}"

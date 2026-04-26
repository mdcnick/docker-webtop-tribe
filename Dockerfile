# syntax=docker/dockerfile:1

# ---------- hermes builder stage ----------
# Builds the hermes venv in an isolated stage so the build toolchain
# never touches the final image. Uses the same Alpine version as the
# LSIO base image so wheels are ABI-compatible at runtime.
FROM alpine:3.23 AS hermes-builder
ARG INSTALL_HERMES="false"
ARG HERMES_REF="v2026.4.13"
RUN if [ "${INSTALL_HERMES}" = "true" ]; then \
      apk add --no-cache python3 py3-pip git build-base python3-dev libffi-dev openssl-dev rust cargo && \
      python3 -m venv /opt/hermes && \
      /opt/hermes/bin/pip install --no-cache-dir --upgrade pip wheel setuptools && \
      /opt/hermes/bin/pip install --no-cache-dir \
        "git+https://github.com/NousResearch/hermes-agent.git@${HERMES_REF}" ; \
    else \
      mkdir -p /opt/hermes ; \
    fi

# ---------- final image ----------
FROM ghcr.io/linuxserver/baseimage-selkies:alpine323

# set version label
ARG BUILD_DATE
ARG VERSION
ARG XFCE_VERSION
LABEL build_version="Linuxserver.io version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="thelamer"

# title
ENV TITLE="Alpine XFCE"

# enterprise build knobs
ARG EXTRA_PACKAGES=""
ARG REMOVE_PACKAGES=""
ARG INCLUDE_CHROMIUM="true"
ARG INSTALL_HERMES="false"

RUN \
  echo "**** add icon ****" && \
  curl -o \
    /usr/share/selkies/www/icon.png \
    https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/webtop-logo.png && \
  echo "**** install packages ****" && \
  if [ "${INCLUDE_CHROMIUM}" = "true" ]; then _CHROMIUM="chromium"; else _CHROMIUM=""; fi && \
  apk add --no-cache \
    adw-gtk3 \
    adwaita-xfce-icon-theme \
    ${_CHROMIUM} \
    mousepad \
    ristretto \
    thunar \
    util-linux-misc \
    xfce4 \
    xfce4-terminal \
    ${EXTRA_PACKAGES} && \
  if [ -n "${REMOVE_PACKAGES}" ]; then apk del --no-cache ${REMOVE_PACKAGES} || true; fi && \
  if [ "${INSTALL_HERMES}" = "true" ]; then \
    echo "**** install hermes runtime deps ****" && \
    apk add --no-cache python3 libffi openssl libstdc++ git ; \
  fi && \
  echo "**** install pty-server + desktop helpers ****" && \
  apk add --no-cache \
    libnotify \
    py3-pip \
    python3 \
    xdotool \
    yad && \
  python3 -m venv /opt/pty-server/venv && \
  /opt/pty-server/venv/bin/pip install --no-cache-dir \
    aiohttp websockets && \
  echo "**** xfce-tweaks ****" && \
  mv \
    /usr/bin/thunar \
    /usr/bin/thunar-real && \
  echo "**** cleanup ****" && \
  rm -f \
    /etc/xdg/autostart/xfce4-power-manager.desktop \
    /etc/xdg/autostart/xscreensaver.desktop \
    /usr/share/xfce4/panel/plugins/power-manager-plugin.desktop && \
  rm -rf \
    /config/.cache \
    /tmp/*

# pull the prebuilt hermes venv from the builder stage (empty dir if disabled)
COPY --from=hermes-builder /opt/hermes /opt/hermes
RUN if [ -x /opt/hermes/bin/hermes ]; then \
      ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes ; \
    fi

# add local files
COPY /root /

# make helper scripts executable
RUN chmod +x /usr/local/bin/browser-lock /usr/local/bin/hnotify

# ports and volumes
EXPOSE 3001 8081

VOLUME /config

# podman/docker parity: s6-overlay graceful shutdown + basic liveness
STOPSIGNAL SIGRTMIN+3
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/ >/dev/null 2>&1 || exit 1

#!/usr/bin/env bash
set -Eeuo pipefail
# no password-free VNC port leaves loopback; QQA authenticates the proxy.
[[ -d /usr/share/novnc ]] || { echo 'Install novnc, websockify and x11vnc first' >&2; exit 1; }
trap 'kill "$vnc_pid" 2>/dev/null || true' EXIT
x11vnc -display :99 -localhost -nopw -rfbport 5901 -forever -shared -quiet &
vnc_pid=$!
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901

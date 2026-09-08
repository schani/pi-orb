#!/bin/bash
# Run as root on the live orb before any agent Docker request.
set -euo pipefail
for unit in docker.service docker.socket containerd.service; do
 test "$(systemctl is-enabled "$unit")" = disabled
 test "$(systemctl is-active "$unit" || true)" = inactive
 done
if sudo -u orb docker info >/dev/null 2>&1; then echo 'unexpected Docker activation' >&2; exit 1; fi
test "$(systemctl is-active docker.service || true)" = inactive
curl -fsS http://127.0.0.1:8080/v1/health | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h["status"]=="ready"; print("READY_WITH_DOCKER_DISABLED",h["sessionId"])'

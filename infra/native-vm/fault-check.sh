#!/bin/bash
# Run as root on the disposable, seeded orb VM with the broker tunnel connected.
set -euo pipefail
printf 'RUNTIME_CRASH_BEGIN\n'
cat /sys/fs/cgroup/system.slice/pi-orb-runtime.service/cgroup.procs >/workspace/old-runtime-pids
systemctl kill --kill-whom=main --signal=SIGKILL pi-orb-runtime.service
python3 - <<'PY'
import json, time, urllib.request
from pathlib import Path
pids = Path('/workspace/old-runtime-pids').read_text().split()
deadline = time.monotonic() + 75  # systemd stop timeout 30s + restart delay 3s + runtime boot
while time.monotonic() < deadline:
    gone = all(not Path('/proc', pid).exists() for pid in pids)
    try:
        health = json.load(urllib.request.urlopen('http://127.0.0.1:8080/v1/health', timeout=2))
        if gone and health['status'] == 'ready':
            print('RUNTIME_CRASH_RECOVERY_OK', health['sessionId'])
            break
    except (OSError, ValueError):
        pass
    time.sleep(.5)
else:
    raise SystemExit('runtime or descendant cleanup failed')
PY
/workspace/workload.sh verify
printf 'DOCKER_FAILURE_BEGIN\n'
systemctl stop docker.socket docker.service
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nExecStartPre=/bin/false\n' >/etc/systemd/system/docker.service.d/experiment-failure.conf
systemctl daemon-reload
if systemctl start docker.service; then
  echo 'expected Docker startup failure' >&2
  exit 1
fi
journalctl -u docker.service -n 15 --no-pager
curl -fsS http://127.0.0.1:8080/v1/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ready"'
rm /etc/systemd/system/docker.service.d/experiment-failure.conf
systemctl daemon-reload
systemctl reset-failed docker.service
systemctl start docker.service
/workspace/workload.sh verify
printf 'DOCKER_FAILURE_RECOVERY_OK\n'

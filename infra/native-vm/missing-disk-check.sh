#!/bin/bash
# Run as root on the fixture created without a data disk, after boot jobs settle.
set -euo pipefail
for unit in pi-orb-runtime.service docker.service docker.socket containerd.service; do
  test "$(systemctl show "$unit" -p ActiveState --value)" = inactive
 done
for unit in pi-orb-runtime.service docker.service containerd.service; do
  test "$(systemctl show "$unit" -p MainPID --value)" = 0
 done
test ! -e /run/pi-orb/environment
test -z "$(ls -A /workspace)"
status=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/pi-orb/boot-status)
python3 -c 'import json,sys; value=json.load(sys.stdin); assert value["phase"] == "workspace"; assert value["status"] == "failed"; assert value["code"] == "workspace_device_timeout"' <<<"$status"
systemctl show workspace.mount pi-orb-bootstrap.service pi-orb-runtime.service docker.service containerd.service -p Id -p ActiveState -p SubState -p Result
journalctl -b -u workspace.mount -u pi-orb-bootstrap -u pi-orb-runtime -u docker -u containerd --no-pager
printf 'MISSING_DISK_FAIL_CLOSED_OK\n'

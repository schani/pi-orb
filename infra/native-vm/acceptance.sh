#!/bin/bash
# Run as root on a newly booted production-image candidate with its data disk attached.
set -euo pipefail

test "$(id -u orb)" = 2000
test "$(id -g orb)" = 2000
sudo -u orb sudo -n true

findmnt --noheadings --output SOURCE --target /workspace | grep -q '/dev/'
workspace_device=$(readlink -f /dev/disk/by-id/google-pi-orb-data)
filesystem_metadata=$(tune2fs -l "$workspace_device")
block_size=$(printf '%s\n' "$filesystem_metadata" | awk -F: '/^Block size:/{gsub(/ /,"",$2); print $2}')
filesystem_bytes=$(printf '%s\n' "$filesystem_metadata" | awk -F: '/^Block count:/{count=$2} /^Block size:/{size=$2} END{gsub(/ /,"",count); gsub(/ /,"",size); printf "%.0f\n", count*size}')
device_bytes=$(blockdev --getsize64 "$workspace_device")
test "$filesystem_bytes" -gt $((10 * 1024 * 1024 * 1024))
test "$device_bytes" -ge "$filesystem_bytes"
test $((device_bytes - filesystem_bytes)) -lt "$block_size"
test "$(stat -c %u:%g /workspace)" = 2000:2000
test "$(stat -c %a /workspace/home)" = 700
test "$(stat -c %U:%G:%a /run/pi-orb/environment)" = root:root:600

systemctl is-active --quiet pi-orb-workspace.service
systemctl is-active --quiet workspace.mount
systemctl is-active --quiet pi-orb-bootstrap.service
systemctl is-active --quiet pi-orb-runtime.service
curl --fail --silent --show-error http://127.0.0.1:8080/v1/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ready"'

for unit in docker.service docker.socket containerd.service; do
  test "$(systemctl is-enabled "$unit")" = disabled
  ! systemctl is-active --quiet "$unit"
done
! sudo -u orb docker info >/dev/null 2>&1
! systemctl is-active --quiet docker.socket

test "$(python3 -c 'import json; print(json.load(open("/etc/docker/daemon.json"))["data-root"])')" = /workspace/docker
test "$(python3 -c 'import tomllib; print(tomllib.load(open("/etc/containerd/config.toml", "rb"))["root"])')" = /workspace/containerd

diagnostic=$(curl --fail --silent --show-error -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/pi-orb/boot-status)
python3 -c 'import json,sys; value=json.load(sys.stdin); assert value["schemaVersion"] == 1; assert value["status"] in ("starting", "ready")' <<<"$diagnostic"

echo native_guest_acceptance_passed

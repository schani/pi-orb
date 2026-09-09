#!/bin/bash
# Run after collecting builder evidence, immediately before stopping for capture.
set -euo pipefail
systemctl stop docker.service docker.socket containerd.service tailscaled.service
# Retain the administrative account, never its credentials. It is separate from
# the UID-2000 runtime identity and can receive new instance-scoped SSH keys.
test "$(id -u pi-orb-build)" != 2000
test "$(getent passwd pi-orb-build | cut -d: -f6)" = /home/pi-orb-build
usermod --lock pi-orb-build
# Fence guest-account reconciliation before deleting authorized keys. Otherwise
# the builder's still-present instance metadata can repopulate them at capture.
# Units stay enabled and restart against the new instance's metadata at boot.
for unit in google-guest-agent.service google-guest-agent-manager.service google-guest-compat-manager.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl stop "$unit"
  fi
done
cat >/etc/systemd/system/pi-orb-host-keys.service <<'EOF'
[Unit]
Description=Create this instance's SSH host keys
Before=ssh.service
[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A
[Install]
WantedBy=multi-user.target
EOF
systemctl enable pi-orb-host-keys.service
mkdir -p /etc/systemd/system/ssh.service.d
printf '[Unit]\nRequires=pi-orb-host-keys.service\nAfter=pi-orb-host-keys.service\n' >/etc/systemd/system/ssh.service.d/host-keys.conf
rm -rf /root/.ssh /root/.config /root/.cache /root/.npm /root/.docker /root/.gsutil /var/lib/tailscale/*
rm -f /root/.npmrc /root/.bash_history
for user_dir in /home/*; do
  rm -rf "$user_dir/.ssh" "$user_dir/.config" "$user_dir/.cache" "$user_dir/.docker" "$user_dir/.gsutil"
  rm -f "$user_dir/.npmrc" "$user_dir/.bash_history"
done
test ! -e /home/pi-orb-build/.ssh
case "$(getent shadow pi-orb-build | cut -d: -f2)" in
  '!'*) ;;
  *) echo 'build administrator password is not locked' >&2; exit 1 ;;
esac
# Removing SSH host keys is the final remote operation: collect evidence first.
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id
truncate -s 0 /etc/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
rm -rf /app/infra
python3 - <<'PY'
from pathlib import Path
import shutil
for directory in ['apps', 'packages']:
 for path in Path('/app', directory).rglob('*.test.ts'):
  path.unlink()
shutil.rmtree('/app/apps/orb-runtime/src/supervisor/.test', ignore_errors=True)
PY
rm -f /home/*/source.tar.gz /home/*/install.sh /home/*/seed-workspace.sh /home/*/seal.sh
rm -rf /var/lib/docker/* /var/lib/containerd/*
rm -f /var/log/pi-orb-image-build*.log
journalctl --rotate
journalctl --vacuum-time=1s
sync

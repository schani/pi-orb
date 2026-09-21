#!/bin/bash
# Run after collecting builder evidence, immediately before stopping for capture.
set -euo pipefail
trap 'status=$?; printf "PI_ORB_SEAL_FAILED=phase=seal,line=%s,status=%s\n" "$LINENO" "$status" >&2' ERR
fail() { printf 'PI_ORB_SEAL_GUARD_FAILED=%s\n' "$1" >&2; exit 1; }
systemctl stop docker.service docker.socket containerd.service tailscaled.service
# Retain the administrative account, never its credentials. It is separate from
# the UID-2000 runtime identity and can receive new instance-scoped SSH keys.
[ "$(id -u pi-orb-build)" != 2000 ] || fail build_admin_uid
[ "$(getent passwd pi-orb-build | cut -d: -f6)" = /home/pi-orb-build ] || fail build_admin_home
usermod --lock pi-orb-build
# Pin Google's host-key owner to the inspected package and effective unit.
# The readiness barrier independently verifies the resulting keys.
/app/infra/native-vm/verify-google-host-key-owner.sh

# Stop reconciliation before installing the new Requires graph: once installed,
# stopping the manager can propagate to SSH through the readiness unit.
for unit in google-guest-agent.service google-guest-agent-manager.service google-guest-compat-manager.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl stop "$unit"
  fi
done

install -m755 /app/infra/native-vm/wait-google-host-keys.sh /usr/local/sbin/pi-orb-wait-google-host-keys
cat >/etc/systemd/system/pi-orb-host-key-ready.service <<'EOF'
[Unit]
Description=Wait for Google-owned SSH host keys
Requires=google-guest-agent-manager.service
After=google-guest-agent-manager.service
Before=ssh.service sshd.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pi-orb-wait-google-host-keys
TimeoutStartSec=2min
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl enable pi-orb-host-key-ready.service
mkdir -p /etc/systemd/system/ssh.service.d
printf '[Unit]\nRequires=pi-orb-host-key-ready.service\nAfter=pi-orb-host-key-ready.service\n' >/etc/systemd/system/ssh.service.d/host-keys.conf
systemctl daemon-reload
/app/infra/native-vm/boot-graph-verifier.sh pi-orb-host-key-ready.service ssh.service

rm -rf /root/.ssh /root/.config /root/.cache /root/.npm /root/.docker /root/.gsutil /var/lib/tailscale/*
rm -f /root/.npmrc /root/.bash_history
for user_dir in /home/*; do
  rm -rf "$user_dir/.ssh" "$user_dir/.config" "$user_dir/.cache" "$user_dir/.docker" "$user_dir/.gsutil"
  rm -f "$user_dir/.npmrc" "$user_dir/.bash_history"
done
[ ! -e /home/pi-orb-build/.ssh ] || fail build_admin_ssh_present
case "$(getent shadow pi-orb-build | cut -d: -f2)" in
  '!'*) ;;
  *) fail build_admin_password_unlocked ;;
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

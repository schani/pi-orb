#!/bin/sh
set -eu
python3 -m unittest -v infra/native-vm/test_guest.py
python3 -m py_compile infra/native-vm/bootstrap.py infra/native-vm/prepare_workspace.py infra/native-vm/boot_diagnostic.py infra/native-vm/runtime_supervisor.py infra/native-vm/test_guest.py infra/native-vm/workspace_filesystem_test.py
infra/native-vm/workspace-filesystem.test.sh
grep -q '^User=orb$' infra/native-vm/pi-orb-runtime.service
grep -q '^Requires=pi-orb-workspace.service$' infra/native-vm/workspace.mount
grep -q '^After=systemd-udev-trigger.service network-online.target$' infra/native-vm/pi-orb-workspace.service
! grep -q '^Requires=dev-disk' infra/native-vm/pi-orb-workspace.service
grep -q '^TimeoutStartSec=10min$' infra/native-vm/pi-orb-workspace.service
grep -q 'Requires=workspace.mount' /etc/systemd/system/docker.service.d/workspace.conf 2>/dev/null || test ! -d /etc/systemd/system/docker.service.d

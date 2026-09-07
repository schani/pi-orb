#!/bin/bash
# A deliberately small repository exercises hooks without touching a real project.
set -euo pipefail
mountpoint -q /workspace
install -d -o2000 -g2000 -m700 /workspace/home
chown 2000:2000 /workspace
sudo -u orb mkdir -p /workspace/repo/.agents
printf '<h1>NATIVE_VM_BROWSER_OK</h1>\n' >/workspace/repo/index.html
install -m755 /app/infra/native-vm/workload.sh /app/infra/native-vm/tool-check.sh /app/infra/native-vm/fault-check.sh /workspace/
cat >/workspace/repo/.agents/setup <<'EOF'
#!/bin/bash
set -euo pipefail
test -z "${PI_ORB_RUNTIME_TOKEN:-}"
test -z "${NATIVE_VM_SECRET:-}"
sudo install -m644 /dev/null /usr/local/share/native-vm-hook-installed
printf 'setup\n' >>/workspace/hook-counts
EOF
cat >/workspace/repo/.agents/resume <<'EOF'
#!/bin/bash
set -euo pipefail
test -n "${PI_ORB_RUNTIME_TOKEN:-}"
test "${NATIVE_VM_SECRET:-}" = 'fixture-only-value'
test -f /usr/local/share/native-vm-hook-installed
printf 'resume\n' >>/workspace/hook-counts
EOF
chmod 755 /workspace/repo/.agents/setup /workspace/repo/.agents/resume
chown -R 2000:2000 /workspace/repo
sudo -u orb git -C /workspace/repo init --initial-branch=main
sudo -u orb git -C /workspace/repo add .
sudo -u orb git -C /workspace/repo -c user.name=Fixture -c user.email=fixture@example.invalid commit -m 'Native VM fixture'
printf 'workspace-sentinel\n' >/workspace/sentinel

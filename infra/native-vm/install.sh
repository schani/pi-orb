#!/bin/bash
# Run only on the disposable Debian image builder, with the source tree at /app.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8
mkdir -p /opt/pi-orb /etc/apt/keyrings
date -u +%Y-%m-%dT%H:%M:%SZ >/opt/pi-orb/build-started-at
cat >/usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 755 /usr/sbin/policy-rc.d
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git ripgrep zip unzip sudo python3 python3-venv python-is-python3 build-essential pkg-config
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/github.gpg
curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /etc/apt/keyrings/tailscale.gpg
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /etc/apt/keyrings/google.asc
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 644 /etc/apt/keyrings/*
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/github.gpg] https://cli.github.com/packages stable main' >/etc/apt/sources.list.d/github.list
echo 'deb [signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian bookworm main' >/etc/apt/sources.list.d/tailscale.list
echo 'deb [signed-by=/etc/apt/keyrings/google.asc] https://packages.cloud.google.com/apt cloud-sdk main' >/etc/apt/sources.list.d/google-cloud-sdk.list
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable' >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends gh tailscale chromium google-cloud-cli docker-ce=5:29.1.3-1~debian.12~bookworm docker-ce-cli=5:29.1.3-1~debian.12~bookworm containerd.io=2.3.4-2~debian.12~bookworm docker-buildx-plugin docker-compose-plugin
curl -fsSL https://nodejs.org/dist/v24.6.0/node-v24.6.0-linux-x64.tar.xz -o /tmp/node.tar.xz
echo 'fda6f6a00759eea0a27e34fcdfdd09c2b0413855edaa7f746246cf81c0186e26  /tmp/node.tar.xz' | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm /tmp/node.tar.xz
curl -fsSL https://static.rust-lang.org/rustup/archive/1.29.0/x86_64-unknown-linux-gnu/rustup-init -o /usr/local/bin/rustup
echo '4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10  /usr/local/bin/rustup' | sha256sum -c -
chmod 755 /usr/local/bin/rustup
for proxy in cargo rustc rustdoc rustfmt cargo-clippy cargo-fmt clippy-driver; do ln -s rustup "/usr/local/bin/$proxy"; done
cd /app
npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=false --ignore-scripts
rm -rf node_modules/node-pty/prebuilds
npm rebuild node-pty
chmod 755 node_modules/agent-browser/bin/agent-browser-linux-x64
find node_modules/agent-browser/bin -type f -name 'agent-browser-*' ! -name agent-browser-linux-x64 -delete
node -e 'const pty = require("node-pty"); const child = pty.spawn("/bin/sh", ["-c", "exit 0"]); child.onExit(({ exitCode }) => process.exit(exitCode))'
ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser
install -m755 apps/orb-runtime/docker/gh apps/orb-runtime/docker/pi-orb-git-credential apps/orb-runtime/docker/pi-orb scripts/pi-orb-gcp-identity /usr/local/bin/
git config --system credential.https://github.com.helper '!pi-orb-git-credential'
cp -a apps/orb-runtime/skills /opt/pi-orb/skills
useradd --uid 2000 --user-group --home-dir /workspace/home --no-create-home --shell /bin/bash orb
usermod -aG docker orb
echo 'orb ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/pi-orb
chmod 440 /etc/sudoers.d/pi-orb
mkdir -p /workspace /etc/docker /etc/containerd
cat >/etc/docker/daemon.json <<'EOF'
{"data-root":"/workspace/docker","log-driver":"local"}
EOF
containerd config default >/etc/containerd/config.toml
sed -i 's#^root = .*#root = "/workspace/containerd"#' /etc/containerd/config.toml
python3 -c 'import tomllib; assert tomllib.load(open("/etc/containerd/config.toml", "rb"))["root"] == "/workspace/containerd"'
install -m755 infra/native-vm/bootstrap.py /usr/local/bin/pi-orb-bootstrap
install -m755 infra/native-vm/prepare_workspace.py /usr/local/bin/pi-orb-prepare-workspace
install -m755 infra/native-vm/boot_diagnostic.py /usr/local/bin/pi-orb-boot-diagnostic
install -m755 infra/native-vm/runtime_supervisor.py /usr/local/bin/pi-orb-runtime-supervisor
install -m644 infra/native-vm/workspace.mount infra/native-vm/pi-orb-workspace.service infra/native-vm/pi-orb-bootstrap.service infra/native-vm/pi-orb-runtime.service infra/native-vm/pi-orb-boot-failure@.service /etc/systemd/system/
for unit in docker.service docker.socket containerd.service; do
  mkdir -p "/etc/systemd/system/$unit.d"
  cat >"/etc/systemd/system/$unit.d/workspace.conf" <<'EOF'
[Unit]
Requires=workspace.mount
After=workspace.mount
BindsTo=workspace.mount
EOF
done
systemctl disable tailscaled.service
systemctl disable docker.service docker.socket containerd.service
systemctl enable workspace.mount pi-orb-bootstrap.service pi-orb-runtime.service
systemctl daemon-reload
rm /usr/sbin/policy-rc.d
apt-get purge -y google-osconfig-agent unattended-upgrades vim vim-common vim-runtime vim-tiny nano wget man-db groff-base
systemctl disable apt-daily.timer apt-daily-upgrade.timer
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
# Keep the complete resolved inventory, including packages inherited from Debian.
dpkg-query -W -f='${Package}\t${Version}\t${Installed-Size}\n' | sort >/opt/pi-orb/packages.tsv
npm ls --workspace @pi-orb/orb-runtime --all --json >/opt/pi-orb/npm-tree.json
node --version >/opt/pi-orb/node-version
/usr/bin/docker --version >/opt/pi-orb/docker-version
install -m755 infra/native-vm/acceptance.sh /opt/pi-orb/acceptance.sh
du -sx /app /usr /opt >/opt/pi-orb/sizes-kib.tsv
infra/native-vm/test.sh
systemd-analyze verify /etc/systemd/system/pi-orb-runtime.service /etc/systemd/system/pi-orb-bootstrap.service /etc/systemd/system/pi-orb-workspace.service /etc/systemd/system/pi-orb-boot-failure@.service /etc/systemd/system/workspace.mount
date -u +%Y-%m-%dT%H:%M:%SZ >/opt/pi-orb/build-finished-at

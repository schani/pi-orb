#!/bin/sh
# Shared by the Docker and native Debian image builds.
set -eu
case "$1" in
  amd64) artifact=bun-linux-x64-baseline; bun_sha=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 ;;
  arm64) artifact=bun-linux-aarch64; bun_sha=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;;
  *) echo "unsupported Bun architecture: $1" >&2; exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --proto "=https" --tlsv1.2 -fsSL \
  "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/${artifact}.zip" \
  -o "$temporary/bun.zip"
echo "$bun_sha  $temporary/bun.zip" | sha256sum --check -
unzip -q "$temporary/bun.zip" -d "$temporary"
install -m 755 "$temporary/$artifact/bun" /usr/local/bin/bun
ln -s bun /usr/local/bin/bunx
bun --version

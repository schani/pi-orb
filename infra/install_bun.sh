#!/bin/sh
# Shared by the Docker and native Debian image builds.
set -eu
case "$1" in
  amd64) artifact=bun-linux-x64-baseline; bun_sha=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76 ;;
  arm64) artifact=bun-linux-aarch64; bun_sha=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
  *) echo "unsupported Bun architecture: $1" >&2; exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --proto "=https" --tlsv1.2 -fsSL \
  "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/${artifact}.zip" \
  -o "$temporary/bun.zip"
echo "$bun_sha  $temporary/bun.zip" | sha256sum --check -
unzip -q "$temporary/bun.zip" -d "$temporary"
install -m 755 "$temporary/$artifact/bun" /usr/local/bin/bun
ln -s bun /usr/local/bin/bunx
bun --version

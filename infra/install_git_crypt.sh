#!/bin/sh
# Shared by the Docker and native Debian image builds; optional owned test prefix.
set -eu
prefix=${1:-/usr/local}
commit=160cf642e1c0f83c1668ad0d59e879d97b97a95b
source_sha=2e01dd367d5c415f9ee8841741a74c1da6d698977fd344995268e5b1cddfa29f
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
printf 'git-crypt source commit=%s sha256=%s\n' "$commit" "$source_sha"
curl --proto "=https" --tlsv1.2 -fsSL \
  "https://github.com/AGWA/git-crypt/archive/${commit}.tar.gz" \
  -o "$temporary/source.tar.gz"
echo "$source_sha  $temporary/source.tar.gz" | sha256sum --check -
mkdir "$temporary/source"
tar -xzf "$temporary/source.tar.gz" -C "$temporary/source" --strip-components=1
make -C "$temporary/source" -j2
test "$("$temporary/source/git-crypt" --version 2>&1)" = "git-crypt 0.8.0"
install -d "$prefix/bin" "$prefix/share/doc/git-crypt"
install -m 755 "$temporary/source/git-crypt" "$prefix/bin/git-crypt"
install -m 644 "$temporary/source/COPYING" "$prefix/share/doc/git-crypt/COPYING"
install -m 644 "$temporary/source.tar.gz" "$prefix/share/doc/git-crypt/source.tar.gz"
"$prefix/bin/git-crypt" --version

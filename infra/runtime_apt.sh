#!/bin/sh
# Retry only acquisition; dpkg-facing installation runs once, without network.
set -eu

apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update
for attempt in 1 2; do
  echo "runtime-apt: download attempt $attempt/2" >&2
  if apt-get -o Acquire::Retries=0 install -y --no-install-recommends --download-only "$@"; then
    echo "runtime-apt: verified archives; installing once without downloads" >&2
    exec apt-get install -y --no-install-recommends --no-download "$@"
  else
    status=$?
    echo "runtime-apt: download attempt $attempt/2 failed (exit $status)" >&2
    if [ "$attempt" -eq 2 ]; then
      exit "$status"
    fi
  fi
done

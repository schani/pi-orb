#!/bin/sh
set -eu

case "$(uname -s)" in
Linux)
  python3 infra/native-vm/workspace_filesystem_test.py
  ;;
*)
  docker run --rm \
    -v "$PWD:/repo:ro" -w /repo \
    node:24.22.1-bookworm python3 infra/native-vm/workspace_filesystem_test.py
  ;;
esac

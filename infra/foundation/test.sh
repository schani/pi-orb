#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tofu fmt -check -recursive "$root/foundation"
TF_DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-foundation-test.XXXXXX")
trap 'rm -rf "$TF_DATA_DIR"' EXIT
export TF_DATA_DIR
tofu -chdir="$root/foundation" init -backend=false -input=false >/dev/null
tofu -chdir="$root/foundation" validate
node --test "$root/foundation/state_split.test.mjs" "$root/foundation/adopt.test.mjs" "$root/foundation/iam_contract.test.mjs"
grep -R -q 'roles/compute.imageUser' "$root/foundation"
! grep -R -q 'orb_vm_ar_reader' "$root/foundation"
grep -R -q 'prefix = "static-plane"' "$root/main.tf"

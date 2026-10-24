#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tofu fmt -check -recursive "$root/foundation"
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-foundation-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export TF_DATA_DIR="$work/data"
module="$work/foundation"
mkdir "$module"
cp "$root/foundation/"*.tf "$root/foundation/.terraform.lock.hcl" "$module/"
cp -R "$root/foundation/tests" "$module/"
tofu -chdir="$module" init -backend=false -input=false -lockfile=readonly >/dev/null
tofu -chdir="$module" validate
# OpenTofu 1.12.6 cannot import in mock tests; omit only adoption directives.
rm "$module/imports.tf"
tofu -chdir="$module" test
grep -R -q 'roles/compute.imageUser' "$root/foundation"
! grep -R -q 'orb_vm_ar_reader' "$root/foundation"
grep -R -q 'prefix = "static-plane"' "$root/main.tf"

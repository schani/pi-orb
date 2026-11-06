#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
"$root/foundation/test-tofu.sh"
tofu fmt -check "$root"
tofu fmt -check -recursive "$root/tests"
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-application-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export TF_DATA_DIR="$work/data"
module="$work/application"
mkdir "$module"
cp "$root/"*.tf "$root/.terraform.lock.hcl" "$module/"
cp -R "$root/tests" "$module/"
tofu -chdir="$module" init -backend=false -input=false -lockfile=readonly >/dev/null
tofu -chdir="$module" validate
# OpenTofu 1.13.2 cannot import in mock tests; omit only adoption directives.
rm "$module/imports.tf"
tofu -chdir="$module" test

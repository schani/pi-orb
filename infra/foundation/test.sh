#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
"$root/foundation/test-tofu.sh"
node --test "$root/foundation/state_split.test.mjs" "$root/foundation/adopt.test.mjs" "$root/foundation/iam_contract.test.mjs"

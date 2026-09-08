#!/bin/bash
# Remove only this experiment's labelled resources, after exporting evidence.
set -euo pipefail
project=playground-dev-6ae7
zone=us-central1-a
prefix=${NATIVE_VM_PREFIX:-pi-orb-vm-spike-riga-0905}
label=${NATIVE_VM_LABEL:-native-vm-riga-0905}
evidence=${NATIVE_VM_EVIDENCE:-.context/native-vm}
for kind in instances disks images; do
  scope=(--project="$project")
  if test "$kind" != images; then scope+=(--zones="$zone"); fi
  gcloud compute "$kind" list "${scope[@]}" \
    --filter="labels.pi-orb-experiment=$label" --format=json >"$evidence/cleanup-$kind-before.json"
  python3 -c 'import json,sys; print("\n".join(x["name"] for x in json.load(open(sys.argv[1]))))' "$evidence/cleanup-$kind-before.json" |
  while IFS= read -r name; do
    test -n "$name" || continue
    case "$name" in "$prefix"-*) ;; *) echo "unexpected owned resource: $name" >&2; exit 1;; esac
    scope=(--project="$project")
    if test "$kind" != images; then scope+=(--zone="$zone"); fi
    test "$(gcloud compute "$kind" describe "$name" "${scope[@]}" --format='value(labels.pi-orb-experiment)')" = "$label"
    gcloud compute "$kind" delete "$name" "${scope[@]}" --quiet
  done
  scope=(--project="$project")
  if test "$kind" != images; then scope+=(--zones="$zone"); fi
  gcloud compute "$kind" list "${scope[@]}" \
    --filter="labels.pi-orb-experiment=$label" --format=json >"$evidence/cleanup-$kind-after.json"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == []' "$evidence/cleanup-$kind-after.json"
done
printf 'CLOUD_EXPERIMENT_CLEANUP_OK\n'

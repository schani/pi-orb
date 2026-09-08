#!/bin/bash
# Explicit stages for disposable experiment resources; never a production deploy.
set -euo pipefail
project=playground-dev-6ae7
zone=us-central1-a
prefix=${NATIVE_VM_PREFIX:-pi-orb-vm-spike-riga-0905}
label=${NATIVE_VM_LABEL:-native-vm-riga-0905}
evidence=${NATIVE_VM_EVIDENCE:-.context/native-vm}
mkdir -p "$evidence"
common=(--project="$project" --zone="$zone")
owned() {
  test "$(gcloud compute instances describe "$1" "${common[@]}" --format='value(labels.pi-orb-experiment)')" = "$label"
}
ssh_vm() { gcloud compute ssh "$1" "${common[@]}" --tunnel-through-iap --command="$2"; }
wait_ssh() {
  local deadline=$((SECONDS + 180))
  until ssh_vm "$1" true >"$evidence/ssh-readiness.log" 2>&1; do
    cat "$evidence/ssh-readiness.log" >>"$evidence/ssh-readiness-history.log"
    # Expected provisioning conditions only; host-key/auth/remote-command errors fail.
    rg -q 'Failed to lookup instance|failed to connect to backend|Connection refused' "$evidence/ssh-readiness.log" || return 1
    test "$SECONDS" -lt "$deadline" || return 1
    sleep 3
  done
}
create_vm() {
  local name=$1 image=$2 image_project=$3
  shift 3
  gcloud compute instances create "$name" "${common[@]}" \
    --machine-type=n2d-highmem-4 --subnet=pi-orb-us-central1 \
    --service-account="pi-orb-orb-vm@$project.iam.gserviceaccount.com" \
    --scopes=https://www.googleapis.com/auth/logging.write \
    --image="$image" --image-project="$image_project" --boot-disk-size=20GB \
    --labels="pi-orb-experiment=$label" "$@" --format=json >"$evidence/$name.json"
}
case "${1:?build/capture/data/seed/boot/missing/tunnel/ssh/stop/start/reset/discard}" in
build)
  version=${2:?image version}
  name="$prefix-builder-$version"
  COPYFILE_DISABLE=1 tar --exclude=node_modules --exclude=__pycache__ --exclude='*.pyc' \
    -czf "$evidence/source.tar.gz" package.json package-lock.json packages/protocol \
    packages/mock-openai packages/luna apps/orb-runtime scripts/pi-orb-gcp-identity infra/native-vm
  create_vm "$name" debian-12-bookworm-v20260902 debian-cloud
  wait_ssh "$name"
  gcloud compute scp "$evidence/source.tar.gz" "$name:source.tar.gz" "${common[@]}" --tunnel-through-iap
  ssh_vm "$name" 'set -eu; sudo mkdir /app; sudo tar -xzf source.tar.gz -C /app; sudo systemd-run --unit=pi-orb-image-build /bin/bash -c "cd /app && exec infra/native-vm/install.sh >/var/log/pi-orb-image-build.log 2>&1"'
  ;;
capture)
  version=${2:?image version}; name="$prefix-builder-$version"
  owned "$name"
  ssh_vm "$name" 'set -eu; sudo cat /opt/pi-orb/build-started-at /opt/pi-orb/build-finished-at; sudo cat /opt/pi-orb/packages.tsv; sudo cat /opt/pi-orb/sizes-kib.tsv; sudo cat /var/log/pi-orb-image-build.log; df -h /' >"$evidence/build-$version.log"
  [[ "$version" =~ ^[a-z0-9-]+$ ]]
  ssh_vm "$name" "set -eu; echo '$version' | sudo tee /opt/pi-orb/image-version; sudo cp /app/infra/native-vm/seal.sh /tmp/seal.sh; sudo bash /tmp/seal.sh" >"$evidence/seal-$version.log" 2>&1
  gcloud compute instances stop "$name" "${common[@]}" --quiet
  gcloud compute images create "$prefix-image-$version" --project="$project" \
    --source-disk="$name" --source-disk-zone="$zone" --labels="pi-orb-experiment=$label" \
    --format=json >"$evidence/image-$version.json"
  ;;
data)
  gcloud compute disks create "$prefix-data" "${common[@]}" --size=50GB --type=pd-balanced \
    --labels="pi-orb-experiment=$label" --format=json >"$evidence/data-disk.json"
  ;;
seed)
  name="$prefix-builder-${2:?unsealed builder version}"; owned "$name"
  test "$(gcloud compute disks describe "$prefix-data" "${common[@]}" --format='value(labels.pi-orb-experiment)')" = "$label"
  gcloud compute instances attach-disk "$name" "${common[@]}" --disk="$prefix-data" --device-name=pi-orb-data
  ssh_vm "$name" 'set -eu; sudo systemctl stop docker.socket docker.service containerd.service; disk=/dev/disk/by-id/google-pi-orb-data; if sudo blkid "$disk"; then echo "refusing to format existing filesystem" >&2; exit 1; fi; sudo mkfs.ext4 -F "$disk"; sudo mount "$disk" /workspace; sudo bash /app/infra/native-vm/seed-workspace.sh; sudo umount /workspace'
  gcloud compute instances detach-disk "$name" "${common[@]}" --disk="$prefix-data"
  ;;
boot)
  create_vm "$prefix-${2:?VM suffix}" "$prefix-image-${3:?image version}" "$project" \
    --metadata-from-file="pi-orb-config=$evidence/config.json" \
    --disk="name=$prefix-data,device-name=pi-orb-data,auto-delete=no"
  wait_ssh "$prefix-$2"
  ;;
missing)
  create_vm "$prefix-missing-disk" "$prefix-image-${2:?image version}" "$project"
  wait_ssh "$prefix-missing-disk"
  ;;
tunnel)
  name="$prefix-${2:?VM suffix}"; owned "$name"
  gcloud compute ssh "$name" "${common[@]}" --tunnel-through-iap -- -N \
    -L127.0.0.1:18180:127.0.0.1:8080 -R127.0.0.1:18100:127.0.0.1:18100 \
    -oExitOnForwardFailure=yes -oServerAliveInterval=15 -oServerAliveCountMax=3
  ;;
ssh)
  name="$prefix-${2:?VM suffix}"; owned "$name"; ssh_vm "$name" "${3:?command}"
  ;;
stop|start|reset)
  name="$prefix-${2:?VM suffix}"; owned "$name"
  gcloud compute instances "$1" "$name" "${common[@]}" --quiet
  ;;
discard)
  name="$prefix-${2:?VM suffix}"; owned "$name"
  gcloud compute instances delete "$name" "${common[@]}" --quiet
  ;;
*) exit 2;;
esac

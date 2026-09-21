#!/bin/bash
set -euo pipefail
root=${PI_ORB_ROOT:-}
metadata=${PI_ORB_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}
curl_command=${PI_ORB_CURL:-curl}
sleep_command=${PI_ORB_SLEEP:-sleep}
header='Metadata-Flavor: Google'
monotonic_now() {
  if test -n "${PI_ORB_CLOCK:-}"; then
    "$PI_ORB_CLOCK"
  else
    read -r uptime _ </proc/uptime
    printf '%s\n' "${uptime%%.*}"
  fi
}
deadline=$(( $(monotonic_now) + 90 ))
echo 'pi-orb host-key barrier: waiting for Google guest-agent first-boot host keys'
while test "$(monotonic_now)" -lt "$deadline"; do
  instance_id=$($curl_command -fsS --max-time 1 -H "$header" "$metadata/instance/id" || true)
  recorded_id=$(tr -d '[:space:]' <"$root/etc/google_instance_id" 2>/dev/null || true)
  complete=true
  test -n "$instance_id" && test "$recorded_id" = "$instance_id" || complete=false
  for pair in ecdsa:ecdsa-sha2-nistp256 ed25519:ssh-ed25519 rsa:ssh-rsa; do
    type=${pair%%:*}
    algorithm=${pair#*:}
    private="$root/etc/ssh/ssh_host_${type}_key"
    public="$private.pub"
    test -s "$private" && test -s "$public" || { complete=false; continue; }
    derived=$(ssh-keygen -y -f "$private" 2>/dev/null | awk 'NR == 1 { print $1 " " $2 }' || true)
    local_key=$(awk 'NR == 1 { print $1 " " $2 }' "$public" 2>/dev/null || true)
    test "${derived%% *}" = "$algorithm" && test "${local_key%% *}" = "$algorithm" || complete=false
    test -n "$derived" && test "$derived" = "$local_key" || complete=false
    published=$($curl_command -fsS --max-time 1 -H "$header" "$metadata/instance/guest-attributes/hostkeys/$algorithm" || true)
    test -n "$published" && test "$published" = "${local_key#* }" || complete=false
  done
  if test "$complete" = true && test "$(monotonic_now)" -lt "$deadline"; then
    fingerprint=$(ssh-keygen -lf "$root/etc/ssh/ssh_host_ed25519_key.pub" | awk '{print $2}')
    echo "pi-orb host-key barrier: ready fingerprint=$fingerprint"
    exit 0
  fi
  $sleep_command 1
done
echo 'pi-orb host-key barrier: Google guest-agent host keys did not become ready within 90 seconds' >&2
exit 1

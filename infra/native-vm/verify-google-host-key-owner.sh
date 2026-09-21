#!/bin/bash
set -euo pipefail
unit=google-guest-agent-manager.service
fail() { printf 'PI_ORB_SEAL_GUARD_FAILED=%s\n' "$1" >&2; exit 1; }
[ "$(dpkg-query -W -f='${Version}' google-guest-agent)" = '1:20260715.00-g1' ] || fail google_package_version
[ "$(systemctl show "$unit" -p Type --value)" = notify ] || fail google_manager_type
[ "$(systemctl is-enabled "$unit")" = enabled ] || fail google_manager_enabled

ssh_id=$(systemctl show ssh.service -p Id --value)
sshd_id=$(systemctl show sshd.service -p Id --value)
[ -n "$ssh_id" ] && [ "$ssh_id" = "$sshd_id" ] || fail google_ssh_canonical_id
matching_edges=0
for edge in $(systemctl show "$unit" -p Before --value); do
  edge_id=$(systemctl show "$edge" -p Id --value)
  [ -n "$edge_id" ] || fail google_manager_before_ssh
  if [ "$edge_id" = "$ssh_id" ]; then matching_edges=$((matching_edges + 1)); fi
done
[ "$matching_edges" -eq 1 ] || fail google_manager_before_ssh

exec_start=$(systemctl show "$unit" -p ExecStart --value)
case "$exec_start" in *'path=/usr/bin/google_guest_agent_manager ;'*) ;; *) fail google_manager_exec;; esac
classic_state=$(systemctl is-enabled google-guest-agent.service 2>/dev/null || true)
[ "$classic_state" = disabled ] || fail google_classic_disabled

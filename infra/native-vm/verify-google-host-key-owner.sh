#!/bin/bash
set -euo pipefail
unit=google-guest-agent-manager.service
test "$(dpkg-query -W -f='${Version}' google-guest-agent)" = '1:20260715.00-g1'
test "$(systemctl show "$unit" -p Type --value)" = notify
test "$(systemctl is-enabled "$unit")" = enabled
before=" $(systemctl show "$unit" -p Before --value) "
case "$before" in *' ssh.service '*) ;; *) exit 1;; esac
case "$before" in *' sshd.service '*) ;; *) exit 1;; esac
exec_start=$(systemctl show "$unit" -p ExecStart --value)
case "$exec_start" in *'path=/usr/bin/google_guest_agent_manager ;'*) ;; *) exit 1;; esac
classic_state=$(systemctl is-enabled google-guest-agent.service 2>/dev/null || true)
test "$classic_state" = disabled

# Retained workspace boot lost its mount job

**Date:** 2026-09-07
**Impact:** A production image replacement left the retained orb in `starting`. Its workspace data remained intact.

The workspace preparation service waited for `network-online.target` and ordered itself before `workspace.mount`. A local mount receives an implicit order before `local-fs.target`. The retained boot exposed the opposite path: `pi-orb-workspace.service` → `basic.target` → `sockets.target` → `dbus.socket` → `sysinit.target` → `systemd-update-utmp.service` → `systemd-tmpfiles-setup.service` → `local-fs.target`. Systemd reported the cycle and deleted `workspace.mount/start` to break it. Disk validation reported ready, but the mount, bootstrap and runtime never ran. Fresh-image validation completed under a different job ordering and did not disprove the cycle.

`workspace.mount` now opts out of implicit default dependencies. It retains explicit `Conflicts=umount.target` and `Before=umount.target` shutdown ordering, while its existing dependency still places it after networked disk validation and before bootstrap, runtime, Docker and containerd. Image construction runs `systemd-analyze --man=no verify multi-user.target` against the enabled transaction and rejects either command failure or output containing `ordering cycle`. The prior check named only the custom units, so it omitted the target edge that closed the cycle.

A Debian negative control with the old unit reproduced the exact cycle. `systemd-analyze` itself returned zero despite reporting it, so the gate also inspects output; that complete gate exits 1 for the old graph and 0 with the corrected mount. Guest contract tests require the mount's default-dependency override and explicit shutdown edges.

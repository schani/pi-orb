#!/usr/bin/python3
"""Validate and grow the ext4 persistent workspace disk before mounting."""
import os
from pathlib import Path
import subprocess
import sys
import time

DEVICE = Path('/dev/disk/by-id/google-pi-orb-data')
DEVICE_WAIT_SECONDS = 90


def run(command):
    return subprocess.run(command, capture_output=True, text=True, check=False)


def wait_for_device(device=DEVICE, timeout=DEVICE_WAIT_SECONDS, monotonic=time.monotonic, sleep=time.sleep):
    deadline = monotonic() + timeout
    while True:
        try:
            device.resolve(strict=True)
            return True
        except FileNotFoundError:
            if monotonic() >= deadline:
                return False
            sleep(1)


def filesystem_size(output):
    fields = {}
    for line in output.splitlines():
        key, separator, value = line.partition(':')
        if separator and key in ('Block count', 'Block size'):
            fields[key] = value.strip()
    try:
        return int(fields['Block count']) * int(fields['Block size'])
    except (KeyError, ValueError):
        return None


def prepare(device=DEVICE, command=run):
    resolved = device.resolve(strict=True)
    size_result = command(['/usr/sbin/blockdev', '--getsize64', str(resolved)])
    if size_result.returncode != 0:
        return 'disk_size_unavailable'
    try:
        size = int(size_result.stdout.strip())
    except ValueError:
        return 'disk_size_invalid'
    if size < 10 * 1024 * 1024 * 1024:
        return 'disk_too_small'

    probe = command(['/usr/sbin/blkid', '-p', '-o', 'value', '-s', 'TYPE', str(resolved)])
    filesystem = probe.stdout.strip()
    if probe.returncode == 0:
        if filesystem != 'ext4':
            return 'unsupported_filesystem'
        metadata = command(['/usr/sbin/tune2fs', '-l', str(resolved)])
        if metadata.returncode != 0:
            return 'filesystem_metadata_failed'
        current_size = filesystem_size(metadata.stdout)
        if current_size is None or current_size > size:
            return 'filesystem_size_invalid'
        if current_size == size:
            return 'filesystem_size_current'
        checked = command(['/usr/sbin/e2fsck', '-f', '-n', str(resolved)])
        if checked.returncode != 0:
            return 'filesystem_check_failed'
        grown = command(['/usr/sbin/resize2fs', str(resolved)])
        return 'filesystem_grown' if grown.returncode == 0 else 'filesystem_resize_failed'
    if probe.returncode != 2:
        return 'disk_probe_failed'
    return 'missing_filesystem'


def main():
    if not wait_for_device():
        result = 'workspace_device_timeout'
    else:
        try:
            result = prepare()
        except (OSError, RuntimeError):
            result = 'workspace_device_unavailable'
    success = result in ('filesystem_size_current', 'filesystem_grown')
    print(result, file=sys.stdout if success else sys.stderr)
    if success:
        subprocess.run(
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'ready', result],
            check=False,
        )
    else:
        subprocess.run(
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'failed', result],
            check=False,
        )
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())

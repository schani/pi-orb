#!/usr/bin/python3
"""Validate the persistent disk and format only a demonstrably blank device."""
import os
from pathlib import Path
import subprocess
import sys
import time

DEVICE = Path('/dev/disk/by-id/google-pi-orb-data')
READ_SIZE = 8 * 1024 * 1024
DEVICE_WAIT_SECONDS = 90


def run(command):
    return subprocess.run(command, capture_output=True, text=True, check=False)


def device_is_zero(device, size):
    with device.open('rb', buffering=0) as source:
        remaining = size
        while remaining:
            chunk = source.read(min(READ_SIZE, remaining))
            if not chunk or chunk.strip(b'\x00'):
                return False
            remaining -= len(chunk)
    return True


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


def prepare(device=DEVICE, command=run):
    resolved = device.resolve(strict=True)
    size_result = command(['/usr/sbin/blockdev', '--getsize64', str(resolved)])
    if size_result.returncode != 0:
        return 'disk_size_unavailable'
    try:
        size = int(size_result.stdout.strip())
    except ValueError:
        return 'disk_size_invalid'
    if size < READ_SIZE:
        return 'disk_too_small'

    probe = command(['/usr/sbin/blkid', '-p', '-o', 'value', '-s', 'TYPE', str(resolved)])
    filesystem = probe.stdout.strip()
    if probe.returncode == 0:
        return 'workspace_ready' if filesystem == 'ext4' else 'unsupported_filesystem'
    if probe.returncode != 2:
        return 'disk_probe_failed'

    signatures = command(['/usr/sbin/wipefs', '--no-act', '--noheadings', '--output', 'TYPE', str(resolved)])
    if signatures.returncode != 0:
        return 'signature_probe_failed'
    if signatures.stdout.strip():
        return 'unrecognized_disk_signature'
    if not device_is_zero(resolved, size):
        return 'disk_not_blank'

    formatted = command(['/usr/sbin/mkfs.ext4', '-F', '-L', 'pi-orb-workspace', str(resolved)])
    return 'workspace_formatted' if formatted.returncode == 0 else 'format_failed'


def main():
    if not wait_for_device():
        result = 'workspace_device_timeout'
    else:
        try:
            result = prepare()
        except (OSError, RuntimeError):
            result = 'workspace_device_unavailable'
    print(result, file=sys.stderr if result not in ('workspace_ready', 'workspace_formatted') else sys.stdout)
    if result not in ('workspace_ready', 'workspace_formatted'):
        subprocess.run(
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'failed', result],
            check=False,
        )
    return 0 if result in ('workspace_ready', 'workspace_formatted') else 1


if __name__ == '__main__':
    sys.exit(main())

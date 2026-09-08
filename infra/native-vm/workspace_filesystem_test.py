#!/usr/bin/python3
"""Exercise workspace growth and damage handling with real e2fsprogs."""
from pathlib import Path
import subprocess
import tempfile

import prepare_workspace as workspace


def make_image(path):
    subprocess.run(['truncate', '-s', '10G', path], check=True)
    subprocess.run(['/usr/sbin/mkfs.ext4', '-q', '-F', path], check=True)


def prepare(path):
    calls = []

    def command(argv):
        calls.append(argv)
        if argv[0] == '/usr/sbin/blockdev':
            return subprocess.CompletedProcess(argv, 0, str(path.stat().st_size) + '\n', '')
        return subprocess.run(argv, capture_output=True, text=True, check=False)

    return workspace.prepare(path, command), calls


with tempfile.TemporaryDirectory(prefix='pi-orb-workspace-filesystem-') as directory:
    root = Path(directory)
    healthy = root / 'healthy.img'
    make_image(healthy)
    subprocess.run(['truncate', '-s', '20G', healthy], check=True)
    result, calls = prepare(healthy)
    assert result == 'filesystem_grown', result
    assert any(argv[0] == '/usr/sbin/e2fsck' and '-n' in argv for argv in calls)
    assert any(argv[0] == '/usr/sbin/resize2fs' for argv in calls)
    metadata = subprocess.run(
        ['/usr/sbin/tune2fs', '-l', healthy], capture_output=True, text=True, check=True
    ).stdout
    fields = dict(
        line.split(':', 1)
        for line in metadata.splitlines()
        if line.startswith(('Block count:', 'Block size:'))
    )
    assert int(fields['Block count'].strip()) * int(fields['Block size'].strip()) == 20 * 1024**3

    damaged = root / 'damaged.img'
    make_image(damaged)
    subprocess.run(
        ['/usr/sbin/debugfs', '-w', '-R', 'write /etc/hostname broken', damaged],
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ['/usr/sbin/debugfs', '-w', '-R', 'clri broken', damaged],
        capture_output=True,
        check=True,
    )
    subprocess.run(['truncate', '-s', '20G', damaged], check=True)
    result, calls = prepare(damaged)
    assert result == 'filesystem_check_failed', result
    assert not any(argv[0] == '/usr/sbin/resize2fs' for argv in calls)

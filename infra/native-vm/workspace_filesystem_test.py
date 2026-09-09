#!/usr/bin/python3
"""Exercise fixed-size admission, template integrity and no mutation with real ext4."""
from pathlib import Path
import subprocess
import tempfile

import prepare_workspace as workspace


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, check=False)


def make_image(path, size='50G'):
    subprocess.run(['truncate', '-s', size, path], check=True)
    subprocess.run(['/usr/sbin/mkfs.ext4', '-q', '-F', path], check=True)


def debugfs(path, command):
    result = run('/usr/sbin/debugfs', '-w', '-R', command, path)
    assert result.returncode == 0, result.stderr


def prepare(path):
    calls = []
    before = path.stat()

    def command(argv):
        calls.append(argv)
        if argv[0] == '/usr/sbin/blockdev':
            return subprocess.CompletedProcess(argv, 0, str(path.stat().st_size) + '\n', '')
        return run(*argv)

    result = workspace.prepare(path, command)
    after = path.stat()
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    assert all(argv[0] in ('/usr/sbin/blockdev', '/usr/sbin/blkid', '/usr/sbin/tune2fs') for argv in calls)
    return result


with tempfile.TemporaryDirectory(prefix='pi-orb-workspace-filesystem-') as directory:
    root = Path(directory)
    healthy = root / 'healthy.img'
    make_image(healthy)
    assert prepare(healthy) == 'filesystem_ready'
    # Same read-only integrity gate the builder runs after its final unmount.
    assert run('/usr/sbin/e2fsck', '-f', '-n', healthy).returncode == 0

    sentinel = root / 'sentinel'
    sentinel.write_text('retained workspace must remain unchanged\n')
    debugfs(healthy, f'write {sentinel} sentinel')
    # Pin mount/check history independently of the test machine's wall clock.
    # Admission must not need the writable check record resize2fs required.
    debugfs(healthy, 'set_super_value lastcheck 1700000000')
    debugfs(healthy, 'set_super_value mtime 1700000001')
    assert prepare(healthy) == 'filesystem_ready'
    assert run('/usr/sbin/debugfs', '-R', 'cat sentinel', healthy).stdout == sentinel.read_text()

    wrong_filesystem = root / 'wrong-filesystem.img'
    make_image(wrong_filesystem, '10G')
    subprocess.run(['truncate', '-s', '50G', wrong_filesystem], check=True)
    assert prepare(wrong_filesystem) == 'filesystem_size_mismatch'

    wrong_disk = root / 'wrong-disk.img'
    make_image(wrong_disk, '20G')
    assert prepare(wrong_disk) == 'disk_size_mismatch'

    # A damaged candidate cannot pass the builder's full integrity gate. Runtime
    # admission is deliberately not an offline repair/check pass on retained disks.
    debugfs(healthy, 'clri sentinel')
    before = healthy.stat().st_mtime_ns
    assert run('/usr/sbin/e2fsck', '-f', '-n', healthy).returncode != 0
    assert healthy.stat().st_mtime_ns == before

    # Runtime admission rejects an unrecognizable superblock without formatting it.
    with healthy.open('r+b') as image:
        image.seek(1024 + 56)  # ext4 primary superblock magic
        image.write(b'\x00\x00')
    assert prepare(healthy) == 'missing_filesystem'

#!/usr/bin/python3
"""Read per-instance configuration without putting credentials in the image."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.request

METADATA_CONFIG_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/attributes/pi-orb-config'
REQUIRED_KEYS = (
    'PI_ORB_ID', 'PI_ORB_RUNTIME_TOKEN', 'PI_ORB_CONTROL_PLANE_URL',
    'PI_ORB_HOST_INCARNATION', 'PI_ORB_REPOSITORY_URL', 'PI_ORB_SKILLS_DIR',
)


def load_config(urlopen=urllib.request.urlopen):
    request = urllib.request.Request(METADATA_CONFIG_URL, headers={'Metadata-Flavor': 'Google'})
    with urlopen(request, timeout=15) as response:
        config = json.load(response)
    if not isinstance(config, dict):
        raise ValueError('configuration is not an object')
    for key, value in config.items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or not isinstance(value, str) or any(character in value for character in ('\n', '\r', '\x00')):
            raise ValueError('invalid instance configuration')
    for required in REQUIRED_KEYS:
        if not config.get(required):
            raise ValueError('missing instance configuration: ' + required)
    return config


def write_environment(config, workspace=Path('/workspace'), runtime_directory=Path('/run/pi-orb'), chown=os.chown):
    config = dict(config)
    config.update({
        'PI_ORB': '1', 'PI_ORB_WORK_DIR': str(workspace), 'HOME': str(workspace / 'home'),
        'RUSTUP_HOME': str(workspace / 'home/.rustup'), 'CARGO_HOME': str(workspace / 'home/.cargo'),
        'PATH': str(workspace / 'home/.cargo/bin') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    })
    chown(workspace, 2000, 2000)
    home = workspace / 'home'
    try:
        home_mode = home.lstat().st_mode
        if stat.S_ISLNK(home_mode) or not stat.S_ISDIR(home_mode):
            raise ValueError('persistent home is not a directory')
    except FileNotFoundError:
        home.mkdir(mode=0o700)
    chown(home, 2000, 2000)
    os.chmod(home, 0o700)
    try:
        runtime_mode = runtime_directory.lstat().st_mode
        if stat.S_ISLNK(runtime_mode) or not stat.S_ISDIR(runtime_mode):
            raise ValueError('runtime directory is not a directory')
    except FileNotFoundError:
        runtime_directory.mkdir(mode=0o700)
    os.chmod(runtime_directory, 0o700)
    path = runtime_directory / 'environment'
    temporary = runtime_directory / 'environment.new'
    temporary.unlink(missing_ok=True)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as output:
            for key, value in config.items():
                escaped = value.replace('\\', '\\\\').replace('"', '\\"')
                output.write(key + '="' + escaped + '"\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    os.chmod(path, 0o600)


def main(urlopen=urllib.request.urlopen, workspace=Path('/workspace'), runtime_directory=Path('/run/pi-orb'), ismount=os.path.ismount, chown=os.chown):
    if not ismount(workspace):
        print('workspace_not_mounted', file=sys.stderr)
        return 1
    try:
        write_environment(load_config(urlopen), workspace, runtime_directory, chown)
        print('instance_configuration_loaded')
        return 0
    except (OSError, ValueError, TypeError) as error:
        print(str(error).replace('\n', ' ') or 'instance_configuration_unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

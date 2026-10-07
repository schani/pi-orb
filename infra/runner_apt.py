"""Use the signed Ubuntu archive instead of the hosted runner's mirror list."""
import re
import sys
from pathlib import Path


MIRROR = rb'(?<!\S)mirror\+file:/etc/apt/apt-mirrors\.txt(?=\s|$)'
ARCHIVE = b'https://archive.ubuntu.com/ubuntu/'
SIGNED_BY = b'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'


def main():
    source = Path(sys.argv[1])
    original = source.read_bytes()
    updated = re.sub(rb'(?m)^URIs:[^\r\n]*',
                     lambda match: re.sub(MIRROR, ARCHIVE, match[0]), original)
    if updated != original:
        source.write_bytes(updated)
    print('Runner APT URIs: https://archive.ubuntu.com/ubuntu/')
    print(SIGNED_BY.decode() if SIGNED_BY in updated.splitlines()
          else 'Signed-By: custom or absent (not logged)')


if __name__ == '__main__':
    main()

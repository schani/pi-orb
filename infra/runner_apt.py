"""Use the signed Ubuntu archive over IPv4 on hosted runners."""
import re
import sys
from pathlib import Path


MIRROR = rb'(?<!\S)mirror\+file:/etc/apt/apt-mirrors\.txt(?=\s|$)'
ARCHIVE = b'https://archive.ubuntu.com/ubuntu/'
SIGNED_BY = b'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'
IPV4 = b'Acquire::ForceIPv4 "true";\n'


def main():
    source = Path(sys.argv[1])
    original = source.read_bytes()
    updated = re.sub(rb'(?m)^URIs:[^\r\n]*',
                     lambda match: re.sub(MIRROR, ARCHIVE, match[0]), original)
    if updated != original:
        source.write_bytes(updated)
    config = Path(sys.argv[2])
    if not config.exists() or config.read_bytes() != IPV4:
        config.write_bytes(IPV4)
    print('Runner APT: ' + IPV4.decode().strip())
    print('Runner APT URIs: https://archive.ubuntu.com/ubuntu/')
    print(SIGNED_BY.decode() if SIGNED_BY in updated.splitlines()
          else 'Signed-By: custom or absent (not logged)')


if __name__ == '__main__':
    main()

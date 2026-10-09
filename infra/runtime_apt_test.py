"""Real APT acquisition against an isolated, signed, loopback repository."""
import getpass
import hashlib
import http.server
import os
import posixpath
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / 'infra/runtime_apt.sh'


@unittest.skipUnless(shutil.which('apt-get') and shutil.which('gpg') and
                     shutil.which('dpkg-deb'), 'requires Debian APT and GPG')
class RuntimeAptTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='orb-apt-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.root.chmod(0o755)
        self.requests = []
        self.faults = []
        self.files = {}
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path = posixpath.normpath(self.path)
                owner.requests.append(path)
                data = owner.files.get(path)
                if data is None:
                    self.send_error(404)
                    return
                fault = owner.faults.pop(0) if path == '/fixture.deb' and owner.faults else None
                if fault == 'size':
                    data = data[:128]
                elif fault == 'hash':
                    data = b'x' * len(data)
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data[:128] if fault == 'truncated' else data)
                self.close_connection = True

            def log_message(self, *_args):
                pass

        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(self.server.server_close)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.make_repository()
        for directory in ['lists/partial', 'archives/partial', 'empty', 'log']:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / 'status').write_text('')
        (self.root / 'sources.list').write_text(
            f'deb [signed-by={self.root}/key.gpg] http://127.0.0.1:{self.server.server_port} ./\n')
        (self.root / 'apt.conf').write_text(f'''
Dir::Etc::sourcelist "{self.root}/sources.list";
Dir::Etc::sourceparts "{self.root}/empty";
Dir::Etc::parts "{self.root}/empty";
Dir::Etc::main "{self.root}/absent";
Dir::State::status "{self.root}/status";
Dir::State::lists "{self.root}/lists";
Dir::State::extended_states "{self.root}/extended_states";
Dir::Cache::archives "{self.root}/archives";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
Dir::Log "{self.root}/log";
APT::Sandbox::User "{getpass.getuser()}";
Acquire::http::Proxy "DIRECT";
Acquire::Languages "none";
''')
        self.env = dict(os.environ, APT_CONFIG=str(self.root / 'apt.conf'))
        # Run actual APT for all acquisition. Intercept only dpkg-facing install:
        # never install fixture packages into the test host.
        bindir = self.root / 'bin'
        bindir.mkdir()
        apt = bindir / 'apt-get'
        apt.write_text(f'''#!/bin/sh
case " $* " in
  *" --no-download "*) echo install >> '{self.root}/installs'; exit "${{INSTALL_EXIT:-0}}" ;;
esac
exec /usr/bin/apt-get "$@"
''')
        apt.chmod(0o755)
        self.env['PATH'] = str(bindir) + ':' + self.env['PATH']

    def stop_server(self):
        self.server.shutdown()
        self.thread.join()

    def run_command(self, args, **kwargs):
        return subprocess.run(args, env=getattr(self, 'env', None),
                              capture_output=True, text=True, timeout=30, **kwargs)

    def make_repository(self):
        package = self.root / 'package'
        (package / 'DEBIAN').mkdir(parents=True)
        (package / 'DEBIAN/control').write_text(
            'Package: orb-apt-fixture\nVersion: 1\nArchitecture: all\n'
            'Maintainer: Fixture <fixture@example.invalid>\nDescription: fixture\n')
        result = self.run_command(['dpkg-deb', '--build', str(package), str(self.root / 'fixture.deb')])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.deb = (self.root / 'fixture.deb').read_bytes()
        packages = (f'Package: orb-apt-fixture\nVersion: 1\nArchitecture: all\n'
                    f'Filename: fixture.deb\nSize: {len(self.deb)}\n'
                    f'SHA256: {hashlib.sha256(self.deb).hexdigest()}\n'
                    'Description: fixture\n\n').encode()
        release = ('Suite: fixture\nCodename: fixture\nDate: Thu, 08 Oct 2026 00:00:00 UTC\n'
                   'SHA256:\n ' + hashlib.sha256(packages).hexdigest() +
                   f' {len(packages)} Packages\n').encode()
        home = self.root / 'gnupg'
        home.mkdir(mode=0o700)
        self.addCleanup(subprocess.run, ['gpgconf', '--homedir', str(home), '--kill', 'gpg-agent'],
                        capture_output=True, timeout=10)
        gpg = ['gpg', '--homedir', str(home), '--batch', '--pinentry-mode', 'loopback', '--passphrase', '']
        result = self.run_command(gpg + ['--quick-generate-key', 'Fixture <fixture@example.invalid>', 'ed25519', 'sign', '0'])
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(gpg + ['--export'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.root / 'key.gpg').write_bytes(result.stdout)
        (self.root / 'Release').write_bytes(release)
        result = self.run_command(gpg + ['--clearsign', '--output', str(self.root / 'InRelease'), str(self.root / 'Release')])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.files = {'/InRelease': (self.root / 'InRelease').read_bytes(),
                      '/Packages': packages, '/fixture.deb': self.deb}

    def apt(self, *args):
        return self.run_command(['/usr/bin/apt-get', *args])

    def helper(self):
        return self.run_command(['sh', str(HELPER), 'orb-apt-fixture'])

    def installs(self):
        path = self.root / 'installs'
        return path.read_text().splitlines() if path.exists() else []

    def assert_valid_archive(self):
        archives = list((self.root / 'archives').glob('*.deb'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_bytes(), self.deb)

    def test_acquire_retries_does_not_cover_unexpected_size(self):
        update = self.apt('update')
        self.assertEqual(update.returncode, 0, update.stdout + update.stderr)
        self.faults = ['size']
        result = self.apt('-o', 'Acquire::Retries=2', 'install', '-y', '--download-only', 'orb-apt-fixture')
        self.assertEqual(result.returncode, 100, result.stdout + result.stderr)
        self.assertIn('File has unexpected size', result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 1)
        self.assertEqual(self.installs(), [])
        print('APT Acquire::Retries=2; unexpected-size GET count=1; exit=100\n' + result.stderr)

    def test_valid_first_attempt_installs_once(self):
        result = self.helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 1)
        self.assertEqual(self.installs(), ['install'])
        self.assert_valid_archive()

    def test_size_then_valid_retries_before_install(self):
        self.faults = ['size']
        result = self.helper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 2)
        self.assertIn('runtime-apt: download attempt 1/2 failed', result.stderr)
        self.assertEqual(self.installs(), ['install'])
        self.assert_valid_archive()

    def test_truncation_then_valid_retries_before_install(self):
        self.faults = ['truncated']
        result = self.helper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 2)
        self.assertEqual(self.installs(), ['install'])
        self.assert_valid_archive()

    def test_repeated_hash_corruption_fails_closed(self):
        self.faults = ['hash', 'hash']
        result = self.helper()
        self.assertEqual(result.returncode, 100, result.stdout + result.stderr)
        self.assertIn('Hash Sum mismatch', result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 2)
        self.assertEqual(self.installs(), [])

    def test_repeated_size_mismatch_exhausts_two_gets(self):
        self.faults = ['size', 'size']
        result = self.helper()
        self.assertEqual(result.returncode, 100, result.stdout + result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 2)
        self.assertEqual(self.installs(), [])

    def test_tampered_signed_index_fails_before_download(self):
        self.files['/Packages'] += b'corruption'
        result = self.helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests.count('/fixture.deb'), 0)
        self.assertEqual(self.installs(), [])

    def test_unsigned_index_fails_before_download(self):
        self.files['/InRelease'] = b'invalid signature'
        result = self.helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests.count('/fixture.deb'), 0)
        self.assertEqual(self.installs(), [])

    def test_install_failure_never_retries_writes(self):
        self.env['INSTALL_EXIT'] = '42'
        result = self.helper()
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual(self.requests.count('/fixture.deb'), 1)
        self.assertEqual(self.installs(), ['install'])

    def test_dockerfile_uses_helper_for_both_package_sets(self):
        text = (ROOT / 'apps/orb-runtime/Dockerfile').read_text()
        self.assertIn('COPY infra/runtime_apt.sh /usr/local/bin/runtime-apt', text)
        self.assertEqual(text.count('runtime-apt git ca-certificates'), 1)
        self.assertEqual(text.count('runtime-apt gh tailscale chromium google-cloud-cli'), 1)
        self.assertNotIn('apt-get install', text)

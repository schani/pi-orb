import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / 'infra/runner_apt.py'
MIRROR = b'mirror+file:/etc/apt/apt-mirrors.txt'
ARCHIVE = b'https://archive.ubuntu.com/ubuntu/'
SIGNED_BY = b'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg'
FIXTURE = (b'# mirror+file:/etc/apt/apt-mirrors.txt\r\n'
           b'Types: deb\r\nURIs: ' + MIRROR + b'\r\n'
           b'Suites: noble noble-updates noble-backports noble-security\r\n'
           b'Components: main restricted universe multiverse\r\n' + SIGNED_BY + b'\r\n'
           b'\r\nTypes: deb\nURIs: https://unrelated.example/ubuntu/\n'
           b'Suites: noble\nSigned-By: /private/key.gpg\n# trailing line\n')


class RunnerAptTests(unittest.TestCase):
    def run_helper(self, source):
        return subprocess.run([sys.executable, str(HELPER), str(source)],
                              capture_output=True, check=False)

    def test_changes_only_exact_uri_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'ubuntu.sources'
            source.write_bytes(FIXTURE)
            expected = FIXTURE.replace(b'URIs: ' + MIRROR, b'URIs: ' + ARCHIVE)
            first = self.run_helper(source)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(source.read_bytes(), expected)
            second = self.run_helper(source)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(source.read_bytes(), expected)
            self.assertIn(ARCHIVE, first.stdout)
            self.assertIn(SIGNED_BY, first.stdout)
            self.assertNotIn(b'/private/', first.stdout)
            self.assertLess(len(first.stdout), 256)

    def test_other_uri_tokens_and_fields_are_unchanged(self):
        fixture = (b'URIs: https://archive.ubuntu.com/ubuntu/ ' + MIRROR +
                   b'.other\nOther: ' + MIRROR + b'\n' + SIGNED_BY)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'ubuntu.sources'
            source.write_bytes(fixture)
            result = self.run_helper(source)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(source.read_bytes(), fixture)

    def test_multiple_uri_tokens_preserve_spacing_and_final_line(self):
        fixture = b'URIs:  ' + MIRROR + b'\thttps://other.example/\nURIs: ' + MIRROR
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'ubuntu.sources'
            source.write_bytes(fixture)
            result = self.run_helper(source)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(source.read_bytes(), fixture.replace(MIRROR, ARCHIVE))

    def test_workflows_prepare_mirror_before_first_apt_operation(self):
        command = 'sudo python3 infra/runner_apt.py /etc/apt/sources.list.d/ubuntu.sources'
        for workflow, job in [('ci', 'checks'), ('e2e', 'e2e'), ('deploy', 'release')]:
            with self.subTest(workflow=workflow):
                text = (ROOT / f'.github/workflows/{workflow}.yml').read_text()
                jobs = dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:|\Z)',
                                       text.split('\njobs:\n', 1)[1], re.M | re.S))
                self.assertIn('runs-on: ubuntu-24.04', jobs[job])
                self.assertEqual(text.count(command), 1)
                self.assertLess(jobs[job].index(command), jobs[job].index('sudo apt-get'))
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        image_job = ci.split('  control-plane-image:\n', 1)[1].split('\n  checks:', 1)[0]
        self.assertNotIn('runner_apt.py', image_job)


if __name__ == '__main__':
    unittest.main()

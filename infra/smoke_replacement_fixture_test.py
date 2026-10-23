"""Failure reporting and process ownership for the offline replacement fixture."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


class ReplacementFixtureTest(unittest.TestCase):
    def test_snapshot_is_bounded_private_and_refuses_untrusted_files(self):
        from infra.smoke_replacement_fixture import capture_failure
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state.json').write_text(json.dumps({'state': 'running', 'starts': 2,
                'incarnation': 1, 'sensitive_jq_inputs': 17, 'token': 'secret-token'}))
            (root / 'commands.jsonl').write_text(json.dumps(['curl', 'secret-argv']) + '\n')
            artifact = capture_failure(root, 'large-metadata', True, 90.1, 123, True)
            self.addCleanup(lambda: __import__('shutil').rmtree(artifact.parent))
            summary = json.loads(artifact.read_text())
            self.assertEqual(summary['state']['sensitive_jq_inputs'], 17)
            self.assertEqual(summary['counts'], {'curl': 1})
            self.assertLess(artifact.stat().st_size, 4096)
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
            self.assertEqual(artifact.parent.stat().st_mode & 0o777, 0o700)
            self.assertNotIn('secret', artifact.read_text())
            (root / 'state.json').unlink()
            (root / 'state.json').symlink_to(root / 'commands.jsonl')
            (root / 'commands.jsonl').write_text('secret' * 200000)
            artifact2 = capture_failure(root, 'secret-mode', False, 90, 123, False)
            self.addCleanup(lambda: __import__('shutil').rmtree(artifact2.parent))
            summary = json.loads(artifact2.read_text())
            self.assertEqual(summary['state'], {})
            self.assertTrue(summary['incomplete'])
            self.assertNotIn('secret', artifact2.read_text())

    @unittest.skipUnless(sys.platform == 'linux', 'Linux descendant-reaping witness')
    def test_timeout_preserves_failure_before_cleanup_and_joins_detached_descendants(self):
        from infra import smoke_replacement_fixture as fixture
        from shutil import rmtree
        for reporter_fails in (False, True):
            with self.subTest(reporter_fails=reporter_fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                program = root / 'wait.py'
                program.write_text('''import os, subprocess, sys
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'], start_new_session=True)
Path(sys.argv[1]).write_text(str(os.getpid()) + ' ' + str(child.pid))
print('ready', flush=True)
child.wait()
''')
                foreign = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'], start_new_session=True)
                self.addCleanup(lambda p=foreign: p.poll() is None and (p.kill(), p.wait()))
                communicate = subprocess.Popen.communicate
                first = [True]
                original = subprocess.TimeoutExpired('secret-argv', 90, output='secret-output', stderr='secret-stderr')
                def expire(process, *args, **kwargs):
                    if first[0]:
                        first[0] = False
                        self.assertEqual(kwargs['timeout'], 90)
                        self.assertEqual(process.stdout.readline(), 'ready\n')
                        raise original
                    return communicate(process, *args, **kwargs)
                capture = fixture.capture_failure
                artifacts = []
                def snapshot(*args):
                    self.assertTrue(root.exists(), 'capture must precede directory cleanup')
                    if reporter_fails:
                        raise OSError('secret-reporter')
                    artifact = capture(*args)
                    artifacts.append(artifact)
                    self.addCleanup(lambda: rmtree(artifact.parent))
                with patch.object(subprocess.Popen, 'communicate', expire), patch.object(fixture, 'capture_failure', snapshot):
                    with self.assertRaises(subprocess.TimeoutExpired) as failure:
                        fixture.run_fixture([sys.executable, str(program), str(root / 'pids')], os.environ.copy(), root, '', False)
                self.assertIs(failure.exception, original)
                for pid in map(int, (root / 'pids').read_text().split()):
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                self.assertIsNone(foreign.poll(), 'foreign owner must be untouched')
                if artifacts:
                    self.assertTrue(json.loads(artifacts[0].read_text())['joined'])
                    self.assertNotIn('secret', artifacts[0].read_text())
            self.assertFalse(root.exists(), 'directory cleanup remains independent')

    def test_cleanup_and_reporter_errors_cannot_replace_the_timeout(self):
        from infra import smoke_replacement_fixture as fixture
        from unittest.mock import Mock
        owner = Mock(pid=123)
        primary = subprocess.TimeoutExpired('secret-argv', 90, output='secret-output')
        owner.communicate.side_effect = [primary, subprocess.TimeoutExpired('secret', 2), OSError('secret-cleanup')]
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(subprocess, 'Popen', return_value=owner), \
             patch.object(fixture, 'capture_failure', side_effect=OSError('secret-reporter')):
            with self.assertRaises(subprocess.TimeoutExpired) as failure:
                fixture.run_fixture(['fixture'], {}, Path(directory), '', False)
        self.assertIs(failure.exception, primary)
        owner.send_signal.assert_called_once_with(signal.SIGTERM)
        owner.kill.assert_called_once()
        self.assertTrue(all('secret' not in note for note in primary.__notes__))

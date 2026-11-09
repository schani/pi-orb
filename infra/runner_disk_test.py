"""Bounded hosted-runner cleanup and the unchanged downstream disk guards."""
import contextlib
import io
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from infra import runner_disk


ROOT = Path(__file__).resolve().parents[1]
HOST = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'ImageOS': 'ubuntu24', 'RUNNER_OS': 'Linux'}
GIB = 1024 ** 3
GUARDS = {
    'e2e': ('Check Docker disk budget',
            'df -h\ntest "$(df -Pk . | awk \'NR == 2 {print $4}\')" -ge 15728640\n'),
    'control-plane-image': ('Check image-build disk headroom',
                            'df -h .\navailable=$(df -PB1 . | awk \'NR == 2 { print $4 }\')\n'
                            'if ! (( available >= 15 * 1024 * 1024 * 1024 )); then\n'
                            "  echo 'Control-plane image build requires 15 GiB free disk.' >&2\n"
                            '  exit 1\nfi\n'),
}


def job_steps(job):
    workflow = 'e2e' if job == 'e2e' else 'ci'
    source = (ROOT / f'.github/workflows/{workflow}.yml').read_text()
    body = dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:|\Z)',
                           source.split('\njobs:\n', 1)[1], re.M | re.S))[job]
    return re.findall(r'      - name: ([^\n]+)\n(.*?)(?=      - name: |\Z)', body, re.S)


def guard_script(job):
    name, expected = GUARDS[job]
    body = dict(job_steps(job))[name]
    script = ''.join(line[10:] + '\n' for line in body.splitlines() if line.startswith('          '))
    return script, expected


class RunnerDiskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.android = self.root / 'usr/local/lib/android'
        (self.android / 'sdk/ndk').mkdir(parents=True)
        (self.android / 'sdk/ndk/tool').write_text('unused SDK fixture')
        self.outside = self.root / 'keep'
        self.outside.mkdir()
        (self.outside / 'node').write_text('retain')
        (self.android / 'external-link').symlink_to(self.outside, target_is_directory=True)
        self.summary = self.root / 'summary'
        self.calls = []
        self.output = io.StringIO()

    def run_cleanup(self, reclaimed=8 * GIB, env=None, fail_rm=False, fail_du=False,
                    retained=False):
        original_run = subprocess.run

        def run(args, **kwargs):
            self.calls.append(args)
            if args[0] == 'df':
                available = 9 * GIB + (reclaimed if not self.android.exists() else 0)
                return subprocess.CompletedProcess(args, 0,
                    f'Filesystem 1B-blocks Used Available Use% Mounted on\nfixture 40000000000 0 {available} 0% /\n')
            if args[0] == 'du' and fail_du:
                raise subprocess.CalledProcessError(1, args, output='du fixture denied')
            if args[0] == 'rm':
                if fail_rm:
                    raise subprocess.CalledProcessError(1, args, output='rm fixture denied')
                if retained:
                    return subprocess.CompletedProcess(args, 0, '')
            return original_run(args, **kwargs)

        environment = {**HOST, 'GITHUB_STEP_SUMMARY': str(self.summary), **(env or {})}
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(runner_disk, 'ANDROID', self.android), \
                patch.object(runner_disk.subprocess, 'run', side_effect=run), \
                contextlib.redirect_stdout(self.output):
            return runner_disk.main()

    def run_guard(self, job, available):
        binary = self.root / 'bin'
        binary.mkdir(exist_ok=True)
        df = binary / 'df'
        df.write_text('#!/bin/sh\n'
                      'case "$1" in -Pk) unit=1024;; *) unit=1;; esac\n'
                      'echo "Filesystem Blocks Used Available Capacity Mounted"\n'
                      f'echo "fixture 40000000000 0 $(({available}/unit)) 0% /"\n')
        df.chmod(0o755)
        script, expected = guard_script(job)
        self.assertEqual(script, expected)
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script],
                              env={**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH']},
                              capture_output=True, text=True, check=False)

    def test_real_bounded_deletion_reclaims_fixture_budget_and_logs_both_phases(self):
        self.assertEqual(self.run_cleanup(), 0, self.output.getvalue())
        self.assertFalse(self.android.exists())
        self.assertEqual((self.outside / 'node').read_text(), 'retain')
        self.assertEqual([args for args in self.calls if args[0] == 'rm'],
                         [['rm', '-rf', '--one-file-system', '--', str(self.android)]])
        log = self.output.getvalue()
        self.assertEqual(log, self.summary.read_text())
        self.assertIn('Before', log)
        self.assertIn('After', log)
        self.assertIn(str(9 * GIB), log)
        self.assertIn(str(17 * GIB), log)
        self.assertIn('du -sx -B1', log)
        self.assertIn('absent', log)
        for job in GUARDS:
            with self.subTest(job=job):
                self.assertEqual(self.run_guard(job, 17 * GIB).returncode, 0)

    def test_original_guards_still_fail_if_android_reclaims_too_little(self):
        self.assertEqual(self.run_cleanup(reclaimed=GIB), 0)
        for job in GUARDS:
            with self.subTest(job=job):
                self.assertNotEqual(self.run_guard(job, 10 * GIB).returncode, 0)
                self.assertNotEqual(self.run_guard(job, 15 * GIB - 1024).returncode, 0)
                self.assertEqual(self.run_guard(job, 15 * GIB).returncode, 0)

    def test_refuses_each_wrong_or_missing_ownership_marker_without_commands(self):
        for key in HOST:
            for value in ['', 'false', 'self-hosted']:
                with self.subTest(key=key, value=value):
                    self.calls.clear()
                    self.assertEqual(self.run_cleanup(env={key: value}), 1)
                    self.assertEqual(self.calls, [])
                    self.assertTrue(self.android.exists())

    def test_root_or_ancestor_symlinks_never_delete_external_data(self):
        for ancestor in [False, True]:
            with self.subTest(ancestor=ancestor):
                link = self.root / ('alias' if ancestor else 'android-link')
                link.symlink_to(self.android.parent if ancestor else self.outside,
                                target_is_directory=True)
                self.android = link / 'android' if ancestor else link
                self.assertEqual(self.run_cleanup(), 1)
                self.assertFalse(any(args[0] == 'rm' for args in self.calls))
                self.assertEqual((self.outside / 'node').read_text(), 'retain')

    def test_production_target_is_only_official_android_root(self):
        self.assertEqual(runner_disk.ANDROID, Path('/usr/local/lib/android'))

    def test_cross_device_root_is_refused_even_if_mount_detection_misses_it(self):
        original_stat = Path.stat

        def stat(path, **kwargs):
            value = original_stat(path, **kwargs)
            if path == self.android:
                fields = list(value)
                fields[2] += 1
                return os.stat_result(fields)
            return value

        with patch.object(Path, 'stat', stat), patch.object(Path, 'is_mount', return_value=False):
            self.assertEqual(self.run_cleanup(), 1)
        self.assertFalse(any(args[0] == 'rm' for args in self.calls))
        self.assertTrue(self.android.exists())

    def test_mount_root_is_refused(self):
        with patch.object(Path, 'is_mount', return_value=True):
            self.assertEqual(self.run_cleanup(), 1)
        self.assertFalse(any(args[0] == 'rm' for args in self.calls))
        self.assertTrue(self.android.exists())

    def test_rm_failure_is_closed_with_after_evidence_and_summary(self):
        self.assertEqual(self.run_cleanup(fail_rm=True), 1)
        self.assertTrue(self.android.exists())
        self.assertIn('After', self.output.getvalue())
        self.assertIn('rm fixture denied', self.output.getvalue())
        self.assertEqual(self.output.getvalue(), self.summary.read_text())

    def test_skipped_nested_filesystem_fails_closed_if_root_remains(self):
        self.assertEqual(self.run_cleanup(retained=True), 1)
        self.assertTrue(self.android.exists())

    def test_measurement_failure_prevents_deletion(self):
        self.assertEqual(self.run_cleanup(fail_du=True), 1)
        self.assertTrue(self.android.exists())
        self.assertFalse(any(args[0] == 'rm' for args in self.calls))

    def test_missing_android_is_idempotent(self):
        self.assertEqual(self.run_cleanup(), 0)
        self.calls.clear()
        self.assertEqual(self.run_cleanup(), 0)
        self.assertFalse(any(args[0] == 'rm' for args in self.calls))

    def test_unwritable_summary_prevents_deletion(self):
        self.summary.mkdir()
        self.assertEqual(self.run_cleanup(), 1)
        self.assertTrue(self.android.exists())
        self.assertFalse(any(args[0] == 'rm' for args in self.calls))

    def test_workflow_scope_order_fixed_command_guards_and_deadlines(self):
        command = ('sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS,'
                   'RUNNER_OS,GITHUB_STEP_SUMMARY python3 infra/runner_disk.py')
        for job in GUARDS:
            with self.subTest(job=job):
                steps = job_steps(job)
                self.assertEqual(steps[0][0], 'Check out repository')
                self.assertEqual(steps[1], ('Reclaim unused runner Android tools',
                                           f'        run: {command}\n\n'))
                self.assertEqual(guard_script(job)[0], GUARDS[job][1])
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        e2e = (ROOT / '.github/workflows/e2e.yml').read_text()
        durable = (ROOT / '.github/workflows/durable-qualification.yml').read_text()
        self.assertEqual(ci.count('infra/runner_disk.py'), 1)
        self.assertEqual(e2e.count('infra/runner_disk.py'), 1)
        self.assertNotIn('infra/runner_disk.py', durable)
        self.assertIn('timeout-minutes: 30', ci)
        self.assertIn('timeout-minutes: 60', e2e)
        self.assertIn('timeout-minutes: 10', e2e)


if __name__ == '__main__':
    unittest.main()

"""Runtime dependency layer boundaries and executable build-log contracts."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class RuntimeDependenciesTests(unittest.TestCase):
    def setUp(self):
        self.dockerfile = (ROOT / 'apps/orb-runtime/Dockerfile').read_text().replace('\\\n', '')
        self.steps = re.findall(r'^RUN (.*)$', self.dockerfile, re.M)
        self.install = next(step for step in self.steps if 'npm ci ' in step)
        self.rebuild = next(step for step in self.steps if 'npm rebuild node-pty' in step)

    def test_install_patch_and_rebuild_are_distinct_cacheable_layers(self):
        self.assertNotEqual(self.install, self.rebuild)
        self.assertIn('--workspace @pi-orb/orb-runtime', self.install)
        self.assertIn('--include-workspace-root=false --ignore-scripts', self.install)
        self.assertIn('node scripts/apply-dependency-patches.mjs', self.install)
        self.assertIn('ln -s /app/node_modules/.bin/agent-browser', self.install)
        self.assertNotIn('npm ci', self.rebuild)
        self.assertNotIn('apply-dependency-patches', self.rebuild)
        first_source = self.dockerfile.index('COPY packages/protocol/src')
        for step in [self.install, self.rebuild]:
            self.assertLess(self.dockerfile.index(step), first_source)

    def test_rebuild_is_offline_with_installed_headers_and_spawn_smoke(self):
        self.assertTrue(self.rebuild.startswith('--network=none '))
        self.assertIn('rm -rf node_modules/node-pty/prebuilds', self.rebuild)
        self.assertIn('npm_config_nodedir=/usr/local npm rebuild node-pty', self.rebuild)
        self.assertIn("pty.spawn('/bin/sh', ['-c', 'exit 0'])", self.rebuild)
        self.assertIn('child.onExit(({ exitCode }) => process.exit(exitCode))', self.rebuild)

    def run_step(self, step, failure=''):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for command in ['npm', 'node', 'rm', 'ln']:
                stub = root / command
                stub.write_text('''#!/bin/sh
printf '%s nodedir=%s\\n' "$(basename "$0") $*" "${npm_config_nodedir:-}" >> "$CALLS"
case "$(basename "$0") $*" in
  *"$FAILURE"*) [ -z "$FAILURE" ] || exit 42 ;;
esac
''')
                stub.chmod(0o755)
            calls = root / 'calls'
            result = subprocess.run(
                ['/bin/sh', '-c', re.sub(r'^--network=none ', '', step)],
                env=dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                         CALLS=str(calls), FAILURE=failure),
                capture_output=True, text=True, timeout=5)
            return result, calls.read_text() if calls.exists() else ''

    def test_progress_reports_separate_install_patch_and_rebuild_durations(self):
        for step, phases in [(self.install, ['npm-install', 'patch']),
                             (self.rebuild, ['pty-rebuild'])]:
            with self.subTest(phases=phases):
                result, calls = self.run_step(step)
                self.assertEqual(result.returncode, 0, result.stderr)
                for phase in phases:
                    self.assertIn(f'runtime-deps:{phase}:start', result.stdout)
                    self.assertRegex(result.stdout,
                                     rf'runtime-deps:{phase}:complete elapsed_s=\d+')
                if phases == ['pty-rebuild']:
                    self.assertIn('npm rebuild node-pty nodedir=/usr/local', calls)

    def test_failures_preserve_status_without_success_markers_or_later_commands(self):
        for step, failure, phase, later in [
            (self.install, 'npm ci', 'npm-install', 'node scripts/'),
            (self.install, 'node scripts/', 'patch', 'ln -s'),
            (self.rebuild, 'npm rebuild', 'pty-rebuild', 'node -e'),
            (self.rebuild, 'node -e', 'pty-rebuild', ''),
        ]:
            with self.subTest(failure=failure):
                result, calls = self.run_step(step, failure)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertIn(f'runtime-deps:{phase}:start', result.stdout)
                self.assertNotIn(f'runtime-deps:{phase}:complete', result.stdout)
                if later:
                    self.assertNotIn(later, calls)

"""Runtime dependency layer boundaries and executable build-log contracts."""
import json
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

    def test_node_version_is_pinned_across_ci_and_container_stages(self):
        for name in ['ci', 'e2e', 'deploy', 'durable-qualification']:
            with self.subTest(workflow=name):
                source = (ROOT / f'.github/workflows/{name}.yml').read_text()
                self.assertEqual(re.findall(r"node-version: '([^']+)'", source), ['24.22.1'])
        for app, count in [('control-plane', 3), ('orb-runtime', 1)]:
            with self.subTest(app=app):
                source = (ROOT / f'apps/{app}/Dockerfile').read_text()
                self.assertEqual(re.findall(r'^FROM (\S+)', source, re.M),
                                 ['node:24.22.1-bookworm-slim'] * count)
        filesystem = (ROOT / 'infra/native-vm/workspace-filesystem.test.sh').read_text()
        self.assertIn('node:24.22.1-bookworm python3', filesystem)

    def test_native_node_archive_is_checksum_verified_before_extraction(self):
        source = (ROOT / 'infra/native-vm/install.sh').read_text()
        download = ('curl -fsSL https://nodejs.org/dist/v24.22.1/'
                    'node-v24.22.1-linux-x64.tar.xz -o /tmp/node.tar.xz')
        checksum = ("echo '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"
                    "  /tmp/node.tar.xz' | sha256sum -c -")
        extraction = 'tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1'
        self.assertIn(download, source)
        self.assertIn(checksum, source)
        self.assertLess(source.index(download), source.index(checksum))
        self.assertLess(source.index(checksum), source.index(extraction))
        self.assertIn('node --version >/opt/pi-orb/node-version', source)

    def test_bun_installer_pins_supported_archives_and_verifies_before_install(self):
        source = (ROOT / 'infra/install_bun.sh').read_text()
        self.assertIn('bun-v1.4.4/${artifact}.zip', source)
        for architecture, artifact, checksum in [
            ('amd64', 'bun-linux-x64-baseline', 'e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76'),
            ('arm64', 'bun-linux-aarch64', 'baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e'),
        ]:
            with self.subTest(architecture=architecture):
                self.assertIn(f'{architecture}) artifact={artifact}; bun_sha={checksum}', source)
        self.assertLess(source.index('sha256sum --check'), source.index('unzip '))
        self.assertIn('install -m 755 "$temporary/$artifact/bun" /usr/local/bin/bun', source)
        self.assertIn('ln -s bun /usr/local/bin/bunx', source)
        result = subprocess.run(['/bin/sh', str(ROOT / 'infra/install_bun.sh'), 'unsupported'],
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported Bun architecture: unsupported', result.stderr)

    def test_bun_checksum_failure_prevents_extraction_and_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curl = root / 'curl'
            curl.write_text('#!/bin/sh\nfor output; do :; done\nprintf corrupt > "$output"\n')
            curl.chmod(0o755)
            for command in ['unzip', 'install', 'ln', 'bun']:
                stub = root / command
                stub.write_text('#!/bin/sh\necho reached >> "$CALLS"\nexit 99\n')
                stub.chmod(0o755)
            for architecture in ['amd64', 'arm64']:
                with self.subTest(architecture=architecture):
                    result = subprocess.run(
                        ['/bin/sh', str(ROOT / 'infra/install_bun.sh'), architecture],
                        env=dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                                 TMPDIR=directory, CALLS=str(root / 'calls')),
                        capture_output=True, text=True, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('FAILED', result.stdout)
                    self.assertFalse((root / 'calls').exists())
                    self.assertFalse(list(root.glob('tmp.*')))

    def test_both_images_install_and_qualify_bun_and_git_crypt(self):
        native = (ROOT / 'infra/native-vm/install.sh').read_text()
        self.assertIn('COPY infra/install_bun.sh /tmp/install_bun.sh', self.dockerfile)
        self.assertIn('sh /tmp/install_bun.sh "$TARGETARCH"', self.dockerfile)
        self.assertIn('sh infra/install_bun.sh amd64', native)
        self.assertRegex(self.dockerfile, r'&& runtime-apt[^\n]*\bgit-crypt\b')
        self.assertRegex(native, r'apt-get install[^\n]*\bgit-crypt\b')
        acceptance = (ROOT / 'infra/native-vm/acceptance.sh').read_text()
        self.assertIn("sudo -u orb sh -ec '", acceptance)
        for source in [self.dockerfile, native, acceptance]:
            with self.subTest(source=source[:30]):
                self.assertIn('test "$(bun --version)" = 1.4.4', source)
                self.assertIn('test "$(bunx --version)" = 1.4.4', source)
                self.assertIn('git-crypt --version', source)

    def test_install_patch_and_rebuild_are_distinct_cacheable_layers(self):
        self.assertNotEqual(self.install, self.rebuild)
        self.assertIn('--workspace @pi-orb/orb-runtime', self.install)
        self.assertIn('--include-workspace-root=false --ignore-scripts', self.install)
        self.assertNotIn('apply-dependency-patches', self.dockerfile)
        self.assertNotIn('COPY vendor', self.dockerfile)
        self.assertNotIn('COPY patches', self.dockerfile)
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
        for step, phases in [(self.install, ['npm-install']),
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

    def test_runtime_declares_only_execution_and_claude_dependencies(self):
        dependencies = json.loads((ROOT / 'apps/orb-runtime/package.json').read_text())['dependencies']
        for package in ['@gotgenes/pi-subagents', '@earendil-works/pi-coding-agent',
                        '@earendil-works/pi-tui', '@pi-orb/luna', '@pi-orb/mock-openai']:
            self.assertNotIn(package, dependencies)
        self.assertEqual(dependencies['@earendil-works/pi-durable'], '1.3.0')
        self.assertIn('@anthropic-ai/claude-agent-sdk', dependencies)

    def test_host_subagent_artifact_is_absent_from_lockfile(self):
        lock = json.loads((ROOT / 'package-lock.json').read_text())
        self.assertNotIn('node_modules/@gotgenes/pi-subagents', lock['packages'])
        self.assertFalse((ROOT / 'vendor').exists())

    def test_native_execution_image_uses_unmodified_runtime_dependencies(self):
        source = (ROOT / 'infra/native-vm/install.sh').read_text()
        self.assertNotIn('apply-dependency-patches', source)

    def test_docker_qualification_uses_central_backend(self):
        source = (ROOT / '.github/workflows/e2e.yml').read_text()
        self.assertNotIn('host-pi', source)
        self.assertNotIn('PI_ORB_AGENT_BACKEND', source)

    def test_runtime_image_omits_central_mock_provider(self):
        self.assertNotIn('packages/mock-openai', self.dockerfile)
        snapshot = (ROOT / 'packages/native-image/src/snapshot.ts').read_text()
        self.assertNotIn('packages/mock-openai', snapshot)

    def test_root_scripts_reference_existing_entrypoints(self):
        scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
        for command in scripts.values():
            for path in re.findall(r'node (apps/[^ ]+\.ts)', command):
                self.assertTrue((ROOT / path).is_file(), path)

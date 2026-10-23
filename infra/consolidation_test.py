"""Single-service deployment and maintenance ordering contracts."""
import json
import re
import subprocess
import unittest
from pathlib import Path
from infra.release_state import SERVICES


class ConsolidationTest(unittest.TestCase):
    def test_foundation_commands_have_one_ci_node_owner(self):
        import os
        import tempfile
        suites = ['state_split.test.mjs', 'adopt.test.mjs', 'iam_contract.test.mjs']
        scripts = json.loads(Path('package.json').read_text())['scripts']
        ci = Path('.github/workflows/ci.yml').read_text()
        self.assertIn('run: infra/foundation/test-tofu.sh', ci)
        self.assertNotIn('run: infra/foundation/test.sh', ci)
        for suite in suites:
            self.assertEqual(scripts['test:infra'].count('infra/foundation/' + suite), 1)
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            log = directory / 'calls'
            for name in ('tofu', 'node'):
                executable = directory / name
                executable.write_text('#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> "$CALLS"\n')
                executable.chmod(0o755)
            env = {**os.environ, 'PATH': work + ':' + os.environ['PATH'], 'CALLS': str(log)}
            for command, count in [('infra/foundation/test-tofu.sh', 0), ('infra/foundation/test.sh', 1)]:
                log.write_text('')
                result = subprocess.run([command], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = log.read_text()
                self.assertIn(' test', calls)
                self.assertEqual(calls.count('node --test'), count)
                for suite in suites:
                    self.assertEqual(calls.count(suite), count)

    def test_one_service_preserves_issuer_resource(self):
        source = Path('infra/run.tf').read_text()
        resources = '\n'.join(path.read_text() for path in Path('infra').glob('*.tf'))
        self.assertEqual(re.findall(r'resource "google_cloud_run_v2_service" "([^"]+)"', resources), ['issuer'])
        for fragment in ['service_account = local.control_plane_email', 'min_instance_count = 1', 'max_instance_count = 1', '"3600s"', 'cpu_idle', '"PRIVATE_RANGES_ONLY"', 'PI_ORB_AUTH_MODE', 'PI_ORB_MACHINE_SUBJECT', 'PI_ORB_OIDC_ISSUER_URL']:
            self.assertIn(fragment, source)
        self.assertNotIn('PI_ORB_ROLE', source)
        self.assertNotIn('iap_enabled', source)
        self.assertEqual(SERVICES, ('pi-orb-issuer',))

    def test_application_image_excludes_deployment_scripts(self):
        dockerfile = Path('apps/control-plane/Dockerfile').read_text()
        self.assertNotIn('COPY infra/', dockerfile)

    def test_saved_plan_allows_service_removal_but_preserves_database(self):
        protected = [
            'google_sql_database_instance.pi_orb', 'google_sql_database.pi_orb',
            'google_sql_user.pi_orb', 'random_password.db',
            'google_secret_manager_secret.database_url',
            'google_secret_manager_secret_version.database_url',
        ]
        changes = [dict(address=address, change=dict(actions=['no-op'])) for address in protected]
        changes += [dict(address='google_cloud_run_v2_service.browser_redirect', change=dict(actions=['delete'])),
                    dict(address='google_cloud_run_v2_service.issuer', change=dict(actions=['update']))]

        def accepted(resource_changes):
            result = subprocess.run(['jq', '-e', '-f', 'infra/check-database-plan.jq'],
                                    input=json.dumps(dict(resource_changes=resource_changes)),
                                    text=True, capture_output=True, check=False)
            return result.returncode == 0

        self.assertTrue(accepted(changes))
        for index, address in enumerate(protected):
            with self.subTest(address=address):
                for actions in (['update'], ['delete'], ['delete', 'create']):
                    unsafe = json.loads(json.dumps(changes))
                    unsafe[index]['change']['actions'] = actions
                    self.assertFalse(accepted(unsafe))
                self.assertFalse(accepted(changes[:index] + changes[index + 1:]))

    def test_issuer_resource_sizing(self):
        source = Path('infra/run.tf').read_text().split('resource "google_cloud_run_v2_service" "issuer" {', 1)[1]
        self.assertRegex(source, r'limits\s+= \{ cpu = "2", memory = "4Gi" \}')
        self.assertRegex(source, r'cpu_idle\s+= false\b')
        self.assertRegex(source, r'min_instance_count\s+= 1\b')
        self.assertRegex(source, r'max_instance_count\s+= 1\b')

    def test_origins_and_secret_boundaries(self):
        self.assertRegex(Path('infra/hosting.tf').read_text(), r'app_origin\s+= local\.oidc_issuer_url')
        source = Path('infra/auth.tf').read_text()
        for fragment in ['google_client_secret', 'cookie_secret', 'google_logging_project_exclusion']:
            self.assertIn(fragment, source)
        self.assertNotIn('secret_data', source)
        self.assertNotIn('google_secret_manager_secret_version', source)
        self.assertIn('data "google_secret_manager_secret" "auth"', source)
        run = Path('infra/run.tf').read_text()
        self.assertIn('var.machine_subject', run)
        self.assertIn('data.google_secret_manager_secret.auth[env.value].secret_id', run)
        self.assertRegex(run, r'version\s+= "1"')
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertNotIn('TF_VAR_google_client_secret', workflow)
        self.assertNotIn('TF_VAR_cookie_secret', workflow)
        self.assertNotIn('--iap', Path('infra/deploy.sh').read_text())

    def test_actions_auth_uses_metadata_and_mapping_secret_reference(self):
        source = Path('infra/release.sh').read_text()
        self.assertIn('python3 -m infra.release_auth "$PROJECT"', source)
        self.assertIn('PI_ORB_GOOGLE_IDENTITY_MAPPINGS=pi-orb-google-identity-mappings:1', source)
        self.assertNotIn('PI_ORB_GOOGLE_IDENTITY_MAPPINGS=$PI_ORB_GOOGLE_IDENTITY_MAPPINGS', source)
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertNotIn('secrets.PI_ORB_GOOGLE_IDENTITY_MAPPINGS', workflow)
        self.assertNotIn('vars.PI_ORB_MACHINE_SUBJECT', workflow)

    def test_maintenance_precedes_schema(self):
        source = Path('infra/release.sh').read_text()
        self.assertLess(source.index('stage plan'), source.index('release_cutover'))
        self.assertLess(source.index('release_cutover'), source.index('stage schema'))
        self.assertIn('KEEP_REMOTE_LOCK=true\n    release_run_child python3 -m infra.release_cutover', source)
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('first_consolidation:', workflow)
        self.assertIn('type: boolean', workflow)
        self.assertNotIn('cutover_manifest', workflow)
        retirement = Path('infra/release_retire.py').read_text()
        self.assertIn('pi-orb-issuer', retirement)
        self.assertIn('pi-orb-ops', retirement)
        self.assertIn('pi-orb-runtime-api', retirement)


if __name__ == '__main__':
    unittest.main()

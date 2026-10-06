"""Single-service deployment and maintenance ordering contracts."""
import re
import unittest
from pathlib import Path
from infra.release_state import SERVICES


class ConsolidationTest(unittest.TestCase):
    def test_browser_redirect_cannot_run_controllers_or_read_application_data(self):
        source = Path('infra/browser-redirect.tf').read_text()
        self.assertIn('name                 = "pi-orb"', source)
        self.assertIn('service_account = local.image_builder_email', source)
        self.assertIn('args    = ["infra/browser-redirect.mjs"]', source)
        self.assertIn('min_instance_count = 0', source)
        self.assertIn('cpu_idle = true', source)
        self.assertEqual(re.findall(r'name\s+= "(PI_ORB_[^"]+)"', source), ['PI_ORB_REDIRECT_ORIGIN'])
        for fragment in ('value_source', 'vpc_access', 'local.control_plane_email', 'PI_ORB_HOST_SPEC_GENERATION'):
            self.assertNotIn(fragment, source)

    def test_one_service_preserves_issuer_resource(self):
        source = Path('infra/run.tf').read_text()
        self.assertEqual(re.findall(r'resource "google_cloud_run_v2_service" "([^"]+)"', source), ['issuer'])
        for fragment in ['service_account = local.control_plane_email', 'min_instance_count = 1', 'max_instance_count = 1', '"3600s"', 'cpu_idle', '"PRIVATE_RANGES_ONLY"', 'PI_ORB_AUTH_MODE', 'PI_ORB_MACHINE_SUBJECT', 'PI_ORB_OIDC_ISSUER_URL']:
            self.assertIn(fragment, source)
        self.assertNotIn('PI_ORB_ROLE', source)
        self.assertNotIn('iap_enabled', source)
        self.assertEqual(SERVICES, ('pi-orb-issuer',))

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
        self.assertLess(source.index('git fetch --quiet origin main', source.index('stage plan')), source.index('release_cutover'))
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

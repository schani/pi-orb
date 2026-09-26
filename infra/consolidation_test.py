"""Single-service deployment and maintenance ordering contracts."""
import re
import unittest
from pathlib import Path
from infra.release_state import SERVICES


class ConsolidationTest(unittest.TestCase):
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
        for fragment in ['google_client_secret', 'cookie_secret', 'secret_data', 'google_logging_project_exclusion']:
            self.assertIn(fragment, source)
        self.assertIn('var.machine_subject', Path('infra/run.tf').read_text())
        self.assertNotIn('--iap', Path('infra/deploy.sh').read_text())

    def test_maintenance_precedes_schema(self):
        source = Path('infra/release.sh').read_text()
        self.assertLess(source.index('release_cutover verify'), source.index('stage schema'))
        retirement = Path('infra/release_retire.py').read_text()
        self.assertIn('pi-orb-issuer', retirement)
        self.assertIn('pi-orb-ops', retirement)
        self.assertIn('pi-orb-runtime-api', retirement)


if __name__ == '__main__':
    unittest.main()

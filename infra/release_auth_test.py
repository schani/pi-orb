"""Metadata-only authentication configuration checks."""
import unittest
from infra.release_auth import verify
from infra.release_state import Result, fail


class Cloud:
    def __init__(self):
        self.calls = []
        self.account = {'email': 'pi-orb-debug@test-project.iam.gserviceaccount.com', 'uniqueId': '123456789012345678901', 'disabled': False}
        self.version = {'name': 'projects/123/secrets/pi-orb-cookie-secret/versions/1', 'state': 'ENABLED'}
        self.failure = None

    def json(self, args):
        self.calls.append(args)
        if self.failure: return self.failure
        if args[:2] == ['iam', 'service-accounts']: return Result(self.account)
        secret = next(item.split('=', 1)[1] for item in args if item.startswith('--secret='))
        return Result({**self.version, 'name': f'projects/123/secrets/{secret}/versions/1'})


class AuthTest(unittest.TestCase):
    def test_existing_account_and_pinned_enabled_versions(self):
        cloud = Cloud()
        result = verify(cloud, 'test-project')
        self.assertEqual(result.value, cloud.account['uniqueId'])
        self.assertIsNone(result.error)
        self.assertEqual(len(cloud.calls), 3)
        self.assertFalse(any('access' in call for call in cloud.calls))

    def test_wrong_account_disabled_or_invalid_subject_declines(self):
        for key, value in [('email', 'someone@test-project.iam.gserviceaccount.com'), ('disabled', True), ('uniqueId', 'email')]:
            cloud = Cloud(); cloud.account[key] = value
            self.assertIsNotNone(verify(cloud, 'test-project').error)
            self.assertEqual(len(cloud.calls), 1)

    def test_disabled_or_wrong_version_declines(self):
        cloud = Cloud(); cloud.version['state'] = 'DISABLED'
        self.assertIsNotNone(verify(cloud, 'test-project').error)
        self.assertEqual(len(cloud.calls), 2)

    def test_boundary_failure_propagates_without_credentials(self):
        cloud = Cloud(); cloud.failure = fail('command', 'metadata unavailable')
        self.assertEqual(verify(cloud, 'test-project'), cloud.failure)

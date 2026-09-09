import tempfile
from pathlib import Path
import unittest
import zipfile
from infra.artifact_guard import inspect


class ArtifactGuardTest(unittest.TestCase):
    def test_rejects_names_even_when_empty(self):
        for name in ["deploy.plan", "plan.tfstate.backup", "deploy.plan.json", "gha-creds-123.json", ".terraform/state"]:
            self.assertIsNotNone(inspect(Path(name)))

    def test_recognizes_renamed_archive_without_reading_secret_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "innocent.backup"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("tfstate", "secret-sentinel")
            self.assertEqual(inspect(path), "OpenTofu plan archive")

    def test_allows_ordinary_zip_and_json_but_rejects_renamed_state_json(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "source.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("source.ts", "code")
            self.assertIsNone(inspect(archive_path))
            path = Path(directory) / "snapshot.json"
            path.write_text('{"terraform_version":"1.12.6","resources":[]}')
            self.assertIsNotNone(inspect(path))
            path.write_text('{"name":"ordinary configuration"}')
            self.assertIsNone(inspect(path))


if __name__ == "__main__":
    unittest.main()

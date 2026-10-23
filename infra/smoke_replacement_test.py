"""Manual replacement smoke, driven only by synthetic command adapters."""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PROJECT_ID = "00000000-0000-4000-8000-000000000001"
ORB_ID = "00000000-0000-4000-8000-000000000002"
USER_ID = "00000000-0000-4000-8000-000000000003"
SECRETS = ("runtime-SENSITIVE-0", "runtime-SENSITIVE-1", "runtime-SENSITIVE-2",
           "metadata-SENSITIVE", "disk-SENSITIVE", "row-SENSITIVE", "auth-SENSITIVE")

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
root = Path(os.environ["FAKE_ROOT"])
state_file = root / "state.json"
s = json.loads(state_file.read_text())
name = Path(sys.argv[0]).name
with (root / "commands.jsonl").open("a") as f:
    f.write(json.dumps([name, *a]) + "\n")
orb = os.environ["PI_ORB_SMOKE_ORB_ID"]
project = os.environ["PI_ORB_SMOKE_PROJECT_ID"]
inst = lambda i: "pi-orb-" + orb + "-i" + str(i)
disk = "pi-orb-data-" + orb
mode = os.environ.get("FAKE_MODE", "")
def save(): state_file.write_text(json.dumps(s))
def flag(key, default=None):
    for i, v in enumerate(a):
        if v == key: return a[i + 1]
        if v.startswith(key + "="): return v.split("=", 1)[1]
    return default
if name == "sleep": sys.exit(0)
if name == "fake-stage2":
    s["stage2"] = True; save(); sys.exit(0)
if name == "gcloud":
    if a[:2] == ["auth", "print-identity-token"]:
        print("auth-SENSITIVE"); sys.exit(0)
    if a[:3] == ["compute", "instances", "list"]:
        filter_value = flag("--filter", "")
        exact = filter_value.rsplit("name=", 1)[1] if "name=" in filter_value else None
        if s["state"] == "failed" and not exact:
            s["failed_lists"] = s.get("failed_lists", 0) + 1; save()
            if mode == "disposal-list-permission" or mode == "negative-list-transport" and s["failed_lists"] >= 2:
                print("PERMISSION_DENIED" if "permission" in mode else "Connection reset by peer", file=sys.stderr)
                sys.exit(1)
        if mode == "old-instance-permission" and exact and s["incarnation"] == 1:
            print("PERMISSION_DENIED", file=sys.stderr); sys.exit(1)
        print("" if s["state"] == "failed" or s.get("deleted") or exact and exact != inst(s["incarnation"])
              else inst(s["incarnation"]))
    elif a[:3] == ["compute", "instances", "describe"]:
        i = int(a[3].rsplit("i", 1)[1])
        if s["state"] == "failed" or i != s["incarnation"]:
            print("PERMISSION_DENIED" if mode == "old-instance-permission" else "NOT_FOUND", file=sys.stderr)
            sys.exit(1)
        desc = {"name": inst(i), "id": str(100 + i),
                "disks": [{"boot": True, "source": "zones/z/disks/boot-" + str(i)},
                          {"boot": False, "source": "zones/z/disks/" + disk}],
                "metadata": {"items": [
                    {"key": "pi-orb-config", "value": json.dumps({"PI_ORB_RUNTIME_TOKEN": "runtime-SENSITIVE-" + str(i)})},
                    {"key": "pi-orb-host-spec-fingerprint", "value": "spec-" + str(i == 2)},
                    {"key": "unrelated", "value": "metadata-SENSITIVE"}]}}
        print(json.dumps(desc) if flag("--format") == "json" else inst(i))
    elif a[:3] == ["compute", "disks", "list"]:
        if mode == "disposal-disk-transport" and s["state"] == "failed":
            print("Connection reset by peer", file=sys.stderr); sys.exit(1)
        exact = flag("--filter", "").rsplit("name=", 1)[-1]
        present = {disk} if s["state"] == "failed" else {disk, "boot-" + str(s["incarnation"])}
        print(exact if exact in present and not s.get("deleted") else "")
    elif a[:3] == ["compute", "disks", "describe"]:
        d = a[3]
        if d != disk:
            print("Connection reset by peer" if mode == "disposal-disk-transport" else "NOT_FOUND", file=sys.stderr)
            sys.exit(1)
        print(json.dumps({"name": disk, "id": "200", "metadata": "disk-SENSITIVE"})
              if flag("--format") == "json" else disk)
    elif a[:2] == ["compute", "ssh"]:
        if mode == "ssh-failure" and s["incarnation"] == 1: sys.exit(1)
    else:
        raise AssertionError(a)
elif name == "curl":
    url = next(v for v in a if v.startswith("https://"))
    method = flag("-X", "GET")
    path = url.split("https://fake.invalid", 1)[1]
    if "-K" in a and flag("-K") == "-":
        config = sys.stdin.read()
        # Store presence, never the credential itself.
        with (root / "configs.jsonl").open("a") as f:
            f.write(json.dumps({"runtime": "runtime-SENSITIVE-0" in config,
                                "auth": "auth-SENSITIVE" in config}) + "\n")
    status = "200"
    body = {}
    if path == "/runtime/v1/tokens/model":
        status = "401"
    elif method == "DELETE":
        s["deleted"] = True; save()
    elif s.get("deleted"):
        status, body = "404", {"error": {"code": "not_found"}}
    elif method == "POST" and path == "/api/v1/projects":
        body = {"id": project}
    elif method == "POST" and path.endswith("/orbs"):
        body = {"id": orb}
    elif path.endswith("/stop"):
        s["state"] = "stopped"; save()
    elif path.endswith("/start"):
        s["starts"] += 1
        s["state"] = "failed" if s["starts"] == 1 else "running"
        s["incarnation"] = max(0, s["starts"] - 1)
        save()
    else:
        body = {"id": orb, "state": s["state"], "unrelated": "row-SENSITIVE"}
    output = flag("--output", flag("-o"))
    if output:
        Path(output).write_text(json.dumps(body))
    if flag("--dump-header"):
        Path(flag("--dump-header")).write_text("HTTP/1.1 " + status + "\r\ncontent-type: application/json\r\n")
    if "-w" in a or "--write-out" in a: print(status, end="")
    elif not output: print(json.dumps(body))
else:
    raise AssertionError(name)
'''


class ReplacementSmokeTest(unittest.TestCase):
    def run_smoke(self, mode="", stage2=False):
        directory = tempfile.TemporaryDirectory(prefix="replacement-test-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "bin").mkdir()
        adapter = root / "adapter"
        adapter.write_text(FAKE)
        adapter.chmod(0o700)
        for name in ("gcloud", "curl", "sleep", "fake-stage2"):
            (root / "bin" / name).symlink_to(adapter)
        (root / "state.json").write_text(json.dumps({
            "state": "running", "starts": 0, "incarnation": 0,
        }))
        evidence = root / "evidence"
        evidence.mkdir(mode=0o755)
        sentinel = root / "untouched"
        sentinel.write_text("untouched")
        (evidence / "old-instance.json").symlink_to(sentinel)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("PI_ORB_", "PROJECT", "OVERALL_TIMEOUT", "POLL_INTERVAL"))}
        env.update(PATH=str(root / "bin") + ":" + os.environ["PATH"],
                   FAKE_ROOT=str(root), FAKE_MODE=mode,
                   PI_ORB_BASE_URL="https://fake.invalid",
                   PI_ORB_APP_ORIGIN="https://fake.invalid", PROJECT="fake-project",
                   PI_ORB_GCP_PROJECT="fake-project", PI_ORB_GCE_ZONE="fake-zone",
                   PI_ORB_USER_ID=USER_ID, PI_ORB_SMOKE_PROJECT_ID=PROJECT_ID,
                   PI_ORB_SMOKE_ORB_ID=ORB_ID, PI_ORB_SMOKE_LOG_DIR=str(evidence))
        if stage2:
            # Login shells reset PATH; this deliberately uses the owned absolute adapter.
            env["PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND"] = str(root / "bin/fake-stage2")
        result = subprocess.run(["bash", str(ROOT / "infra/smoke-compute-replacement.sh")],
                                env=env, capture_output=True, text=True, timeout=90)
        return root, evidence, sentinel, result

    def assert_private_evidence(self, root, evidence, sentinel, result):
        self.assertEqual(sentinel.read_text(), "untouched", "preexisting symlink followed")
        children = [p for p in evidence.iterdir() if p.is_dir()]
        self.assertEqual(len(children), 1, "allocate a fresh evidence directory")
        child = children[0]
        self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o700)
        files = list(child.iterdir())
        self.assertTrue(files)
        retained = result.stdout + result.stderr
        for path in files:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)
            retained += path.read_text()
        commands = (root / "commands.jsonl").read_text()
        for secret in SECRETS:
            self.assertNotIn(secret, retained, "credential/raw metadata in evidence")
            self.assertNotIn(secret, commands, "credential in process argv")
        return child

    def test_private_allowlisted_evidence_and_stdin_bearer_including_stage2(self):
        root, evidence, sentinel, result = self.run_smoke(stage2=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.assert_private_evidence(root, evidence, sentinel, result)
        for name, i in (("old-instance", 0), ("new-instance", 1), ("stage2-instance", 2)):
            summary = json.loads((child / (name + ".json")).read_text())
            self.assertEqual(summary["id"], str(100 + i))
            self.assertEqual(summary["name"], "pi-orb-" + ORB_ID + "-i" + str(i))
            self.assertNotIn("metadata", summary)
        configs = [json.loads(line) for line in (root / "configs.jsonl").read_text().splitlines()]
        self.assertTrue(any(c["runtime"] for c in configs))

    def test_observation_failures_never_prove_disposal_or_negative_windows(self):
        for mode, starts in (("disposal-list-permission", 1), ("disposal-disk-transport", 1),
                             ("negative-list-transport", 1), ("old-instance-permission", 2)):
            with self.subTest(mode=mode):
                root, _, _, result = self.run_smoke(mode=mode)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(json.loads((root / "state.json").read_text())["starts"], starts)

    def test_failure_dump_excludes_raw_disk_and_orb_metadata(self):
        root, evidence, sentinel, result = self.run_smoke(mode="ssh-failure")
        self.assertNotEqual(result.returncode, 0)
        child = self.assert_private_evidence(root, evidence, sentinel, result)
        self.assertEqual(json.loads((child / "orb.json").read_text())["state"], "running")
        self.assertEqual(json.loads((child / "data-disk.json").read_text())["id"], "200")


if __name__ == "__main__":
    unittest.main()

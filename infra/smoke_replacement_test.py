"""Manual replacement smoke, driven only by synthetic command adapters."""
import json
import os
import shutil
from pathlib import Path
import stat
import tempfile
import unittest

from infra.smoke_replacement_fixture import run_fixture

ROOT = Path(__file__).resolve().parents[1]
PROJECT_ID = "00000000-0000-4000-8000-000000000001"
ORB_ID = "00000000-0000-4000-8000-000000000002"
USER_ID = "00000000-0000-4000-8000-000000000003"
SECRETS = ("runtime-SENSITIVE-0", "runtime-SENSITIVE-1", "runtime-SENSITIVE-2",
           "metadata-SENSITIVE", "disk-SENSITIVE", "row-SENSITIVE", "auth-SENSITIVE")

FAKE = r'''#!/usr/bin/env -S python3 -S
import json, os, sys
a = sys.argv[1:]
root = os.environ["FAKE_ROOT"]
state_file = root + "/state.json"
with open(state_file) as f: s = json.load(f)
name = os.path.basename(sys.argv[0])
with open(root + "/commands.jsonl", "a") as f:
    f.write(json.dumps([name, *a]) + "\n")
orb = os.environ["PI_ORB_SMOKE_ORB_ID"]
project = os.environ["PI_ORB_SMOKE_PROJECT_ID"]
inst = lambda i: "pi-orb-" + orb + "-i" + str(i)
disk = "pi-orb-data-" + orb
mode = os.environ.get("FAKE_MODE", "")
def save():
    with open(state_file, "w") as f: json.dump(s, f)
def flag(key, default=None):
    for i, v in enumerate(a):
        if v == key: return a[i + 1]
        if v.startswith(key + "="): return v.split("=", 1)[1]
    return default
if name == "jq":
    import stat, subprocess
    payload = sys.stdin.buffer.read()
    if b"runtime-SENSITIVE-" in payload:
        s["sensitive_jq_inputs"] = s.get("sensitive_jq_inputs", 0) + 1; save()
        if stat.S_ISREG(os.fstat(0).st_mode):
            print("raw description stdin is disk-backed", file=sys.stderr); sys.exit(42)
    reply = subprocess.run([os.environ["FAKE_REAL_JQ"], *a], input=payload, capture_output=True)
    sys.stdout.buffer.write(reply.stdout); sys.stderr.buffer.write(reply.stderr)
    sys.exit(reply.returncode)
if name == "date":
    import time
    s["clock_calls"] = s.get("clock_calls", 0) + 1; save()
    print(int(time.time()) + s["clock_calls"] * 60); sys.exit(0)
if name == "fake-stage2":
    if mode == "stage2-failure": sys.exit(7)
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
        if mode == "provider-list-error" and s.get("deleted"):
            print("PERMISSION_DENIED", file=sys.stderr); sys.exit(1)
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
                    {"key": "unrelated", "value": "metadata-SENSITIVE" + ("x" * 65536 if mode == "large-metadata" else "")}]}}
        print(json.dumps(desc) if flag("--format") == "json" else inst(i))
    elif a[:3] == ["compute", "disks", "list"]:
        if mode == "disposal-disk-transport" and s["state"] == "failed":
            print("Connection reset by peer", file=sys.stderr); sys.exit(1)
        exact = flag("--filter", "").rsplit("name=", 1)[-1]
        present = {disk} if s["state"] == "failed" else {disk, "boot-" + str(s["incarnation"])}
        print(exact if exact in present and not s.get("deleted") or mode == "provider-leak" and exact == disk else "")
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
        with open(root + "/configs.jsonl", "a") as f:
            f.write(json.dumps({"runtime": "runtime-SENSITIVE-0" in config,
                                "auth": "auth-SENSITIVE" in config}) + "\n")
    status = "200"
    body = {}
    if path == "/runtime/v1/tokens/model":
        status = "401"
    elif method == "DELETE":
        if mode == "delete-refused":
            status, body = "403", {"error": {"code": "forbidden"}}
        else:
            s["deleted"] = True; save()
    elif s.get("deleted"):
        if mode == "cleanup-wrong-body":
            body = {"unrelated": True}
        elif mode == "cleanup-orb-present" and "/orbs/" in path:
            body = {"id": orb}
        else:
            status, body = "404", {"error": {"code": "not_found"}}
    elif method == "GET" and ((mode == "preexisting-project" and path.endswith(project)) or
                              (mode == "preexisting-orb" and path.endswith(orb))):
        body = {"id": project if path.endswith(project) else orb}
    elif method == "GET" and (path.endswith(project) and not s.get("project_created") or
                             path.endswith(orb) and not s.get("orb_created")):
        status, body = "404", {"error": {"code": "not_found"}}
    elif method == "POST" and (path == "/api/v1/projects" or path.endswith("/orbs")):
        from pathlib import Path
        kind, identifier = ("project", project) if path == "/api/v1/projects" else ("orb", orb)
        evidence = (Path(root) / "evidence").glob("*/fixtures.jsonl")
        if any('"outcome":"requested"' in p.read_text() and identifier in p.read_text() for p in evidence):
            s.setdefault("recorded_before_create", []).append(kind)
        s[kind + "_created"] = True; save()
        body = {"id": identifier}
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
        with open(output, "w") as f: json.dump(body, f)
    if flag("--dump-header"):
        with open(flag("--dump-header"), "w") as f:
            f.write("HTTP/1.1 " + status + "\r\ncontent-type: application/json\r\n")
    if "-w" in a or "--write-out" in a: print(status, end="")
    elif not output: print(json.dumps(body))
else:
    raise AssertionError(name)
'''


class ReplacementSmokeTest(unittest.TestCase):
    def run_smoke(self, mode="", stage2=False, user=USER_ID):
        directory = tempfile.TemporaryDirectory(prefix="replacement-test-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "bin").mkdir()
        adapter = root / "adapter"
        adapter.write_text(FAKE)
        adapter.chmod(0o700)
        for name in ("gcloud", "curl", "fake-stage2"):
            (root / "bin" / name).symlink_to(adapter)
        sleep = root / "bin/sleep"
        sleep.write_text("""#!/bin/sh
{ printf '["sleep"'; for arg do printf ',"%s"' "$arg"; done; printf ']\\n'; } >> "$FAKE_ROOT/commands.jsonl"
""")
        sleep.chmod(0o700)
        if mode == "large-metadata":
            (root / "bin/jq").symlink_to(adapter)
        if mode in {"provider-leak", "cleanup-orb-present"}:
            (root / "bin/date").symlink_to(adapter)
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
                   FAKE_ROOT=str(root), FAKE_MODE=mode, FAKE_REAL_JQ=shutil.which("jq"),
                   PI_ORB_BASE_URL="https://fake.invalid",
                   PI_ORB_APP_ORIGIN="https://fake.invalid", PROJECT="fake-project",
                   PI_ORB_GCP_PROJECT="fake-project", PI_ORB_GCE_ZONE="fake-zone",
                   PI_ORB_USER_ID=user, PI_ORB_SMOKE_PROJECT_ID=PROJECT_ID,
                   PI_ORB_SMOKE_ORB_ID=ORB_ID, PI_ORB_SMOKE_LOG_DIR=str(evidence))
        if stage2:
            # Login shells reset PATH; this deliberately uses the owned absolute adapter.
            env["PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND"] = str(root / "bin/fake-stage2")
        result = run_fixture(["bash", str(ROOT / "infra/smoke-compute-replacement.sh")],
                             env, root, mode, stage2)
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
        root, evidence, sentinel, result = self.run_smoke(mode="large-metadata", stage2=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        child = self.assert_private_evidence(root, evidence, sentinel, result)
        for name, i in (("old-instance", 0), ("new-instance", 1), ("stage2-instance", 2)):
            summary = json.loads((child / (name + ".json")).read_text())
            self.assertEqual(summary["id"], str(100 + i))
            self.assertEqual(summary["name"], "pi-orb-" + ORB_ID + "-i" + str(i))
            self.assertNotIn("metadata", summary)
        configs = [json.loads(line) for line in (root / "configs.jsonl").read_text().splitlines()]
        self.assertTrue(any(c["runtime"] for c in configs))
        ssh = [c for c in self.commands(root) if c[:3] == ["gcloud", "compute", "ssh"]]
        self.assertEqual(len(ssh), 4)
        for command in ssh:
            self.assertIn("--tunnel-through-iap", command)
        state = json.loads((root / "state.json").read_text())
        self.assertEqual(state["recorded_before_create"], ["project", "orb"])
        self.assertEqual(state["sensitive_jq_inputs"], 17)
        commands = self.commands(root)
        self.assertEqual(sum(c[0] == "sleep" for c in commands), 130)
        self.assertEqual(sum(c[0] == "jq" for c in commands), 323)
        self.assertEqual(sum(c[0] == "curl" for c in commands), 151)
        self.assertEqual(sum(c[0] == "gcloud" for c in commands), 305)
        self.assertEqual(sum(c[0] == "fake-stage2" for c in commands), 1)

        self.assertTrue(any(c[:3] == ["gcloud", "auth", "print-identity-token"] for c in commands))
        requests = [c for c in commands if c[0] == "curl" and any("/api/v1/" in a for a in c)]
        self.assertTrue(requests)
        for request in requests:
            self.assertIn("X-Pi-Orb-User-Id: " + USER_ID, request)
            self.assertIn("--connect-timeout", request)
            self.assertIn("--max-time", request)
        for kind, identifier in (("projects", PROJECT_ID), ("orbs", ORB_ID)):
            url = "https://fake.invalid/api/v1/" + kind + "/" + identifier
            deletes = [i for i, c in enumerate(commands) if url in c and "DELETE" in c]
            self.assertEqual(len(deletes), 1)
            self.assertTrue(any(url in c and "GET" in c for c in commands[deletes[0] + 1:]))
        records = [json.loads(line) for line in (child / "fixtures.jsonl").read_text().splitlines()]
        for kind, identifier in (("project", PROJECT_ID), ("orb", ORB_ID)):
            outcomes = [r["outcome"] for r in records if r["kind"] == kind and r["id"] == identifier]
            self.assertEqual(outcomes, ["requested", "created", "deleted"])
        self.assertIn("cleanup verified", result.stdout)

    def commands(self, root):
        return [json.loads(line) for line in (root / "commands.jsonl").read_text().splitlines()]

    def test_adversarial_ownership_observation_and_cleanup(self):
        for mode in (
            "ssh-failure", "stage2-failure", "delete-refused", "cleanup-wrong-body",
            "cleanup-orb-present", "provider-list-error", "provider-leak",
            "preexisting-project", "preexisting-orb", "missing-user",
            "disposal-list-permission", "disposal-disk-transport",
            "negative-list-transport", "old-instance-permission",
        ):
            with self.subTest(mode=mode):
                root, evidence, sentinel, result = self.run_smoke(
                    mode=mode, stage2=mode == "stage2-failure",
                    user="" if mode == "missing-user" else USER_ID)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("smoke passed", result.stdout)
                if mode == "missing-user":
                    self.assertIn("PI_ORB_USER_ID", result.stderr)
                    self.assertFalse((root / "commands.jsonl").exists())
                    continue
                commands = self.commands(root)
                child = self.assert_private_evidence(root, evidence, sentinel, result)
                if mode.startswith("preexisting-"):
                    self.assertFalse(any("POST" in c or "DELETE" in c or
                        c[:3] == ["gcloud", "compute", "ssh"] for c in commands))
                    self.assertFalse((child / "fixtures.jsonl").exists())
                elif mode in {"ssh-failure", "stage2-failure"}:
                    self.assertFalse(any("DELETE" in c for c in commands))
                    self.assertIn("Failed fixtures retained", result.stderr)
                    records = [json.loads(line) for line in (child / "fixtures.jsonl").read_text().splitlines()]
                    self.assertEqual([(r["kind"], r["id"]) for r in records if r["outcome"] == "retained"],
                                     [("project", PROJECT_ID), ("orb", ORB_ID)])
                    self.assertEqual(json.loads((child / "orb.json").read_text())["state"], "running")
                    self.assertEqual(json.loads((child / "data-disk.json").read_text())["id"], "200")
                elif mode == "delete-refused":
                    self.assertEqual(sum("DELETE" in c for c in commands), 1,
                                     "do not cascade after refused project deletion")
                elif mode in {"disposal-list-permission", "disposal-disk-transport",
                              "negative-list-transport", "old-instance-permission"}:
                    self.assertEqual(json.loads((root / "state.json").read_text())["starts"],
                                     2 if mode == "old-instance-permission" else 1)


if __name__ == "__main__":
    unittest.main()

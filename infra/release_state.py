#!/usr/bin/env python3
"""Token-free release records and Cloud Run identity checks.

All cloud IO is behind Cloud; callers receive classified failures, never raw
credential-bearing CLI/HTTP errors. Only validated records are published.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Literal
import urllib.error
import urllib.parse
import urllib.request


@dataclass(frozen=True)
class Failure:
    kind: Literal["command", "http", "invalid", "io", "conflict", "timeout"]
    message: str


@dataclass(frozen=True)
class Result:
    value: Any = None
    error: Failure | None = None


def fail(kind, message):
    return Result(error=Failure(kind, message))


def command(args, *, data=None, timeout=120):
    try:
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return fail("timeout", f"{args[0]} command timed out")
    except OSError:
        return fail("command", f"cannot execute {args[0]}")
    if result.returncode:
        # Only allowlisted classifications, never third-party response bodies.
        classification = re.search(rb"\b(PERMISSION_DENIED|UNAUTHENTICATED|RESOURCE_EXHAUSTED|NOT_FOUND)\b", result.stderr)
        suffix = f" ({classification.group().decode()})" if classification else ""
        return fail("command", f"{' '.join(args[:3])} exited {result.returncode}{suffix}")
    return Result(result.stdout)


def parse_json(data):
    try:
        return Result(json.loads(data))
    except (ValueError, UnicodeError):
        return fail("invalid", "invalid JSON at adapter boundary")


def load(path):
    try:
        data = Path(path).read_bytes()
    except OSError:
        return fail("io", "cannot read release scratch")
    return parse_json(data)


def save(path, value):
    try:
        temporary = Path(str(path) + ".next")
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    except OSError:
        return fail("io", "cannot write release scratch")
    return Result(value)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _url):
        return None


class Cloud:
    def __init__(self, run=command, request=None):
        self.run = run
        self.request = request or urllib.request.build_opener(NoRedirect()).open

    def json(self, args):
        result = self.run(["gcloud", *args, "--format=json"])
        return result if result.error else parse_json(result.value)

    def http(self, method, url, body=None):
        token = self.run(["gcloud", "auth", "print-access-token"])
        if token.error:
            return token
        try:
            request = urllib.request.Request(url, method=method,
                data=None if body is None else json.dumps(body).encode(), headers={
                    "Authorization": f"Bearer {token.value.decode().strip()}",
                    "Content-Type": "application/json",
                })
            with self.request(request, timeout=30) as response:
                return parse_json(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return Result(None)
            return fail("conflict" if error.code == 412 else "http", f"cloud request HTTP {error.code}")
        except (OSError, ValueError, urllib.error.URLError):
            return fail("http", "cloud request unavailable")

    def object(self, bucket, key):
        url = f"https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe='')}/o/{urllib.parse.quote(key, safe='')}"
        metadata = self.http("GET", url)
        if metadata.error or metadata.value is None:
            return metadata
        generation = metadata.value.get("generation") if isinstance(metadata.value, dict) else None
        if not isinstance(generation, str) or not generation.isdigit():
            return fail("invalid", "GCS object has no generation")
        body = self.http("GET", url + "?alt=media&ifGenerationMatch=" + generation)
        if body.error:
            return body
        if body.value is None:
            return fail("conflict", "GCS object disappeared during read")
        return Result({"generation": generation, "body": body.value})

    def put(self, bucket, key, body, generation):
        query = urllib.parse.urlencode({"uploadType": "media", "name": key, "ifGenerationMatch": generation})
        result = self.http("POST", f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?{query}", body)
        if result.error:
            return result
        if not isinstance(result.value, dict) or not str(result.value.get("generation", "")).isdigit():
            return fail("invalid", "GCS did not acknowledge the record generation")
        return result

    def replace(self, bucket, key, body):
        previous = self.object(bucket, key)
        if previous.error:
            return previous
        generation = "0" if previous.value is None else previous.value["generation"]
        return self.put(bucket, key, body, generation)


SERVICES = ("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")
PHASES = ("preflight", "checks", "build", "plan", "schema", "apply", "retire", "activate", "lifecycle", "identity", "complete")
OUTCOMES = ("running", "failed-before-apply", "applied-but-unvalidated", "validated")
FIELDS = {"schemaVersion", "releaseId", "commit", "runnerCommit", "project", "region", "zone", "workflowUrl", "validatesRelease",
          "startedAt", "finishedAt", "phase", "outcome", "exitCode", "applyAttempted", "gates", "artifacts",
          "previousServing", "serving", "retirement", "fixtures", "migrationJob"}
SNAPSHOT_FIELDS = {"service", "revision", "image", "generation"}
ARTIFACT_FIELDS = {"control_plane_image", "native_image_resource", "native_image_id", "workspace_image_resource", "workspace_image_id", "deploy_generation"}


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value) is not None


def valid_snapshot(value):
    if not isinstance(value, list) or len(value) != 4 or not all(isinstance(item, dict) and set(item) == SNAPSHOT_FIELDS and isinstance(item["service"], str) for item in value):
        return False
    return {item["service"] for item in value} == set(SERVICES) and all(
        valid_id(item["revision"]) and
        (item["generation"] is None if item["service"] == "pi-orb-issuer" else type(item["generation"]) is int and 0 < item["generation"] <= 9007199254740991) and
        isinstance(item["image"], str) and re.fullmatch(r"[a-z0-9./:-]+@sha256:[a-f0-9]{64}", item["image"])
        for item in value)


def valid_artifacts(value):
    return isinstance(value, dict) and set(value) == ARTIFACT_FIELDS and (
        type(value["deploy_generation"]) is int and 0 < value["deploy_generation"] <= 9007199254740991 and
        isinstance(value["control_plane_image"], str) and re.fullmatch(r"[a-z0-9./:-]+@sha256:[a-f0-9]{64}", value["control_plane_image"]) and
        all(isinstance(value[key], str) and re.fullmatch(r"[0-9]+", value[key]) for key in ("native_image_id", "workspace_image_id")) and
        all(isinstance(value[key], str) and re.fullmatch(r"projects/[a-z0-9-]+/global/images/[a-z0-9-]+", value[key]) for key in ("native_image_resource", "workspace_image_resource")))


def validate_record(record):
    # Nested data is allowlisted too: a mistakenly supplied plan or environment
    # dump cannot become an artifact just because its filename looks right.
    if not isinstance(record, dict) or set(record) != FIELDS or type(record.get("schemaVersion")) is not int or record.get("schemaVersion") != 1:
        return False
    if not valid_id(record["releaseId"]) or not all(re.fullmatch(r"[a-f0-9]{40}", str(record[key])) for key in ("commit", "runnerCommit")):
        return False
    if not all(valid_id(record[key]) for key in ("project", "region", "zone")):
        return False
    if record["phase"] not in PHASES or record["outcome"] not in OUTCOMES:
        return False
    if record["workflowUrl"] is not None and not re.fullmatch(r"https://github.com/schani/pi-orb/actions/runs/[0-9]+", str(record["workflowUrl"])):
        return False
    if record["validatesRelease"] is not None and not valid_id(record["validatesRelease"]):
        return False
    for key in ("startedAt", "finishedAt"):
        if record[key] is not None and not re.fullmatch(r"[0-9-]+T[0-9:]+Z", str(record[key])):
            return False
    if not isinstance(record["applyAttempted"], bool) or record["exitCode"] is not None and (not isinstance(record["exitCode"], int) or not 0 <= record["exitCode"] <= 255):
        return False
    if not isinstance(record["gates"], dict) or any(key not in PHASES or value not in ("running", "passed", "failed") for key, value in record["gates"].items()):
        return False
    if record["artifacts"] is not None and not valid_artifacts(record["artifacts"]):
        return False
    if any(record[key] is not None and not valid_snapshot(record[key]) for key in ("previousServing", "serving")):
        return False
    if record["migrationJob"] is not None and not valid_id(record["migrationJob"]):
        return False
    if not isinstance(record["fixtures"], list) or any(not isinstance(item, dict) or set(item) != {"kind", "id", "outcome"} or item["kind"] not in ("project", "orb") or not valid_id(item["id"]) or item["outcome"] not in ("requested", "created", "deleted", "retained", "cleanup-failed") for item in record["fixtures"]):
        return False
    retirement = record["retirement"]
    if retirement is not None:
        if not isinstance(retirement, dict) or set(retirement) != {"after", "revisions", "zeroes", "operations"}:
            return False
        if not re.fullmatch(r"[0-9-]+T[0-9:]+Z", str(retirement["after"])) or not isinstance(retirement["revisions"], list) or not all(valid_id(item) for item in retirement["revisions"]):
            return False
        if not isinstance(retirement["operations"], list) or not all(valid_id(item) for item in retirement["operations"]):
            return False
        if not isinstance(retirement["zeroes"], dict) or any(key not in retirement["revisions"] or not isinstance(value, dict) or set(value) != {"active", "idle"} or not all(isinstance(stamp, str) and re.fullmatch(r"[0-9-]+T[0-9:.]+Z", stamp) for stamp in value.values()) for key, value in retirement["zeroes"].items()):
            return False
    return True


def summarize_service(name, body):
    if not isinstance(body, dict):
        return fail("invalid", "invalid Cloud Run service")
    metadata, status, spec = (body.get(key, {}) for key in ("metadata", "status", "spec"))
    if not all(isinstance(item, dict) for item in (metadata, status, spec)):
        return fail("invalid", "invalid Cloud Run service fields")
    template = spec.get("template", {})
    if not isinstance(template, dict) or not isinstance(template.get("spec", {}), dict):
        return fail("invalid", "invalid Cloud Run template")
    if not isinstance(metadata.get("annotations", {}), dict) or not isinstance(status.get("conditions", []), list) or not all(isinstance(item, dict) for item in status.get("conditions", [])):
        return fail("invalid", "invalid Cloud Run status")
    traffic = status.get("traffic", [])
    if not isinstance(traffic, list) or not all(isinstance(item, dict) for item in traffic):
        return fail("invalid", "invalid Cloud Run traffic")
    revision = status.get("latestReadyRevisionName")
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if not valid_id(revision) or revision != status.get("latestCreatedRevisionName") or not str(metadata.get("generation", "")).isdigit() or str(metadata.get("generation")) != str(status.get("observedGeneration")) or not any(item.get("type") == "Ready" and item.get("status") == "True" for item in status.get("conditions", [])):
        return fail("invalid", f"{name} is not fully Ready")
    if len(traffic) != 1 or traffic[0].get("percent") != 100 or traffic[0].get("revisionName") != revision:
        return fail("invalid", f"{name} does not serve exactly one revision")
    if name == "pi-orb" and (traffic[0].get("tag") != "files" or metadata.get("annotations", {}).get("run.googleapis.com/iap-enabled") != "true"):
        return fail("invalid", "browser files routing or native IAP is not enabled")
    if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict) or not isinstance(containers[0].get("env", []), list) or not all(isinstance(item, dict) for item in containers[0].get("env", [])):
        return fail("invalid", "unexpected Cloud Run container inventory")
    generations = [item.get("value") for item in containers[0].get("env", []) if item.get("name") == "PI_ORB_HOST_SPEC_GENERATION"]
    if name != "pi-orb-issuer" and (len(generations) != 1 or not isinstance(generations[0], str) or not generations[0].isdigit()):
        return fail("invalid", "missing deployment generation")
    if name == "pi-orb-issuer" and generations:
        return fail("invalid", "issuer unexpectedly has lifecycle configuration")
    return Result({"service": name, "revision": revision, "image": containers[0].get("image"), "generation": None if name == "pi-orb-issuer" else int(generations[0])})


def snapshot(cloud, project, region):
    result = []
    for name in SERVICES:
        service = cloud.json(["run", "services", "describe", name, "--project", project, "--region", region])
        if service.error:
            return service
        summary = summarize_service(name, service.value)
        if summary.error:
            return summary
        result.append(summary.value)
    return Result(result) if valid_snapshot(result) else fail("invalid", "invalid serving image identities")


def publish(cloud, record):
    if not validate_record(record):
        return fail("invalid", "refusing to publish a non-allowlisted release record")
    bucket = f"pi-orb-tfstate-{record['project']}"
    stored = cloud.replace(bucket, f"static-plane/releases/{record['releaseId']}.json", record)
    if stored.error:
        return stored
    return cloud.replace(bucket, "static-plane/releases/latest.json", {"releaseId": record["releaseId"]})


def activate(cloud, record):
    if record["artifacts"] is None or record["serving"] is None or record["retirement"] is None or record["retirement"]["operations"] or set(record["retirement"]["zeroes"]) != set(record["retirement"]["revisions"]):
        return fail("invalid", "retirement proof and serving identity are required before activation")
    current = snapshot(cloud, record["project"], record["region"])
    if current.error:
        return current
    if current.value != record["serving"] or any(item["image"] != record["artifacts"]["control_plane_image"] or item["service"] != "pi-orb-issuer" and item["generation"] != record["artifacts"]["deploy_generation"] for item in current.value):
        return fail("conflict", "serving deployment changed before activation")
    bucket = f"pi-orb-tfstate-{record['project']}"
    key = "static-plane/releases/active.json"
    previous = cloud.object(bucket, key)
    if previous.error:
        return previous
    generation = record["artifacts"]["deploy_generation"]
    if previous.value is not None:
        body = previous.value["body"]
        if not isinstance(body, dict) or type(body.get("generation")) is not int or body["generation"] > generation:
            return fail("conflict", "activation would regress authority")
        if body["generation"] == generation:
            return Result(body)
    return cloud.put(bucket, key, {"generation": generation, "releaseId": record["releaseId"], "activatedAt": now()}, "0" if previous.value is None else previous.value["generation"])


def write_vars(path, values):
    if not valid_artifacts(values):
        return fail("invalid", "invalid release variables")
    try:
        Path(path).write_text("".join(f"{key} = {json.dumps(value)}\n" for key, value in values.items()))
        Path(path).chmod(0o600)
    except OSError:
        return fail("io", "cannot write release variables")
    return Result()


def current_vars(cloud, record, path):
    service = cloud.json(["run", "services", "describe", "pi-orb", "--project", record["project"], "--region", record["region"]])
    if service.error:
        return service
    checked = summarize_service("pi-orb", service.value)
    if checked.error:
        return checked
    container = service.value["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item.get("value") for item in container.get("env", []) if isinstance(item, dict) and isinstance(item.get("name"), str)}
    values = {"control_plane_image": checked.value["image"], "deploy_generation": checked.value["generation"]}
    for key, name in {
        "native_image_resource": "PI_ORB_GCE_IMAGE_RESOURCE", "native_image_id": "PI_ORB_GCE_IMAGE_ID",
        "workspace_image_resource": "PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE", "workspace_image_id": "PI_ORB_GCE_WORKSPACE_IMAGE_ID",
    }.items():
        values[key] = env.get(name)
    return write_vars(path, values)


def recover(cloud, record, release_id):
    bucket = f"pi-orb-tfstate-{record['project']}"
    if release_id == "latest":
        pointer = cloud.object(bucket, "static-plane/releases/latest.json")
        if pointer.error:
            return pointer
        if pointer.value is None or not isinstance(pointer.value["body"], dict):
            return fail("invalid", "no recorded release to validate")
        release_id = pointer.value["body"].get("releaseId")
    if not valid_id(release_id):
        return fail("invalid", "invalid release ID")
    source = cloud.object(bucket, f"static-plane/releases/{release_id}.json")
    if source.error:
        return source
    if source.value is None or not validate_record(source.value["body"]):
        return fail("invalid", "requested release does not exist or has an invalid record")
    original = source.value["body"]
    if not original["applyAttempted"] or original["artifacts"] is None or original["retirement"] is None or original["project"] != record["project"] or original["region"] != record["region"] or original["zone"] != record["zone"]:
        return fail("invalid", "release is not eligible for validation-only operation")
    current = snapshot(cloud, record["project"], record["region"])
    if current.error:
        return current
    if any(item["image"] != original["artifacts"]["control_plane_image"] or item["service"] != "pi-orb-issuer" and item["generation"] != original["artifacts"]["deploy_generation"] for item in current.value):
        return fail("conflict", "deployed services do not match the recorded accepted artifacts")
    if original["serving"] is not None and current.value != original["serving"]:
        return fail("conflict", "deployed revisions changed since the recorded release")
    for key in ("commit", "artifacts", "previousServing", "retirement"):
        record[key] = original[key]
    record["serving"], record["validatesRelease"] = current.value, release_id
    record["applyAttempted"], record["outcome"] = True, "applied-but-unvalidated"
    return Result(record)


def main(argv):
    if len(argv) < 3:
        print("usage: release_state.py <init|stage|vars|snapshot|check|publish|activate|finish> RECORD ...", file=sys.stderr)
        return 2
    action, path, *args = argv[1:]
    cloud = Cloud()
    if action == "init" and len(args) == 6:
        release_id, commit, project, region, zone, workflow_url = args
        record = {"schemaVersion": 1, "releaseId": release_id, "commit": commit, "runnerCommit": commit, "project": project, "region": region, "zone": zone,
                  "workflowUrl": workflow_url or None, "validatesRelease": None, "startedAt": now(), "finishedAt": None,
                  "phase": "preflight", "outcome": "running", "exitCode": None, "applyAttempted": False,
                  "gates": {"preflight": "running"}, "artifacts": None, "previousServing": None, "serving": None,
                  "retirement": None, "fixtures": [], "migrationJob": None}
        result = save(path, record) if validate_record(record) else fail("invalid", "invalid release identity")
    else:
        loaded = load(path)
        if loaded.error:
            result = loaded
        elif not validate_record(loaded.value):
            result = fail("invalid", "invalid release record")
        else:
            record = loaded.value
            result = Result()
            if action == "stage" and len(args) == 1 and args[0] in PHASES:
                record["gates"][record["phase"]] = "passed"
                record["phase"] = args[0]
                record["gates"][args[0]] = "running"
                if args[0] == "apply":
                    record["applyAttempted"] = True
                    record["outcome"] = "applied-but-unvalidated"
                result = save(path, record)
            elif action == "vars" and len(args) == 1:
                try:
                    text = Path(args[0]).read_text()
                except OSError:
                    result = fail("io", "cannot read release variables")
                else:
                    values = {}
                    for line in text.splitlines():
                        match = re.fullmatch(r'([a-z_]+)\s*=\s*(?:"([^"]+)"|([0-9]+))\s*', line)
                        if not match or match[1] in values:
                            result = fail("invalid", "unexpected release variable")
                            break
                        values[match[1]] = match[2] if match[2] is not None else int(match[3])
                    if not result.error:
                        if not valid_artifacts(values):
                            result = fail("invalid", "invalid release artifacts")
                        else:
                            record["artifacts"] = values
                            result = save(path, record)
            elif action == "fixture" and len(args) == 3:
                kind, identifier, outcome = args
                entry = {"kind": kind, "id": identifier, "outcome": outcome}
                record["fixtures"] = [item for item in record["fixtures"] if (item["kind"], item["id"]) != (kind, identifier)] + [entry]
                if not validate_record(record):
                    result = fail("invalid", "invalid fixture record")
                else:
                    result = save(path, record)
                    if not result.error:
                        result = publish(cloud, record)
            elif action == "migration-job" and len(args) == 1 and valid_id(args[0]):
                record["migrationJob"] = args[0]
                result = save(path, record)
            elif action == "preflight-vars" and len(args) == 1:
                result = current_vars(cloud, record, args[0])
            elif action == "recover" and len(args) == 1:
                result = recover(cloud, record, args[0])
                if not result.error:
                    result = save(path, result.value)
            elif action == "generation" and len(args) == 1 and record["artifacts"] is not None and record["previousServing"] is not None:
                authority = cloud.object(f"pi-orb-tfstate-{record['project']}", "static-plane/releases/active.json")
                if authority.error:
                    result = authority
                elif authority.value is not None and (not isinstance(authority.value["body"], dict) or type(authority.value["body"].get("generation")) is not int):
                    result = fail("invalid", "invalid existing activation generation")
                else:
                    active = 0 if authority.value is None else authority.value["body"]["generation"]
                    previous = next(item["generation"] for item in record["previousServing"] if item["service"] == "pi-orb")
                    record["artifacts"]["deploy_generation"] = max(record["artifacts"]["deploy_generation"], previous + 1, active + 1)
                    result = write_vars(args[0], record["artifacts"])
                    if not result.error:
                        result = save(path, record)
            elif action in ("snapshot", "check", "previous", "check-previous"):
                result = snapshot(cloud, record["project"], record["region"])
                if not result.error:
                    if action in ("check", "check-previous") and result.value != record["previousServing" if action == "check-previous" else "serving"]:
                        result = fail("conflict", "serving deployment no longer matches this release")
                    elif action == "snapshot" and (record["artifacts"] is None or any(item["image"] != record["artifacts"]["control_plane_image"] or (item["service"] != "pi-orb-issuer" and item["generation"] != record["artifacts"]["deploy_generation"]) for item in result.value)):
                        result = fail("conflict", "applied services do not match accepted artifacts")
                    elif action not in ("check", "check-previous"):
                        record["previousServing" if action == "previous" else "serving"] = result.value
                        result = save(path, record)
            elif action == "publish":
                result = publish(cloud, record)
            elif action == "activate":
                result = activate(cloud, record)
            elif action == "finish" and len(args) == 1 and args[0].isdigit():
                status = int(args[0])
                if status == 0 and (record["phase"] != "complete" or not record["applyAttempted"] or record["serving"] is None or record["artifacts"] is None or any(value == "failed" for value in record["gates"].values())):
                    print("release: refusing an incomplete success record", file=sys.stderr)
                    return 1
                record["finishedAt"], record["exitCode"] = now(), status
                record["gates"][record["phase"]] = "passed" if status == 0 else "failed"
                record["outcome"] = "validated" if status == 0 else "applied-but-unvalidated" if record["applyAttempted"] else "failed-before-apply"
                result = save(path, record) if validate_record(record) else fail("invalid", "invalid final release record")
            else:
                result = fail("invalid", "invalid release record operation")
    if result.error:
        print(f"release: {result.error.kind}: {result.error.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

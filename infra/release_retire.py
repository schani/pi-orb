#!/usr/bin/env python3
"""Observe retirement without pausing the UI. Deletion is NOT the proof."""
from datetime import datetime, timezone
import sys
import re
import time
import urllib.parse
from infra.release_state import Cloud, Result, fail, load, now, publish, save, utc_epoch as epoch, valid_id, valid_retirement, validate_record

# instance_count samples every 60s and can take 120s to become visible.
# https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z
INSTANCE_COUNT_VISIBILITY_SECONDS = 180

def metrics(cloud, project, region, start, end, services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")):
    result = []
    for service in services:
        query = {
            "filter": f'metric.type="run.googleapis.com/container/instance_count" AND resource.type="cloud_run_revision" AND resource.labels.service_name="{service}" AND resource.labels.location="{region}"',
            "interval.startTime": start, "interval.endTime": end, "view": "FULL", "pageSize": "10000",
        }
        seen = set()
        while True:
            page = cloud.http("GET", f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?{urllib.parse.urlencode(query)}")
            if page.error:
                return page
            if not isinstance(page.value, dict) or not isinstance(page.value.get("timeSeries", []), list):
                return fail("invalid", "malformed Monitoring page")
            result.extend(page.value.get("timeSeries", []))
            token = page.value.get("nextPageToken", "")
            if not isinstance(token, str):
                return fail("invalid", "invalid Monitoring page token")
            if token == "":
                break
            if token in seen:
                return fail("invalid", "repeated or invalid Monitoring page token")
            seen.add(token)
            query["pageToken"] = token
    return Result(result)


def samples(series, region, end):
    result = {}
    for item in series:
        if not isinstance(item, dict) or not isinstance(item.get("resource"), dict) or not isinstance(item.get("metric"), dict):
            return fail("invalid", "malformed instance-count series")
        if item["resource"].get("type") != "cloud_run_revision" or item["metric"].get("type") != "run.googleapis.com/container/instance_count":
            continue
        labels = item["resource"].get("labels", {})
        metric_labels = item["metric"].get("labels", {})
        if not isinstance(labels, dict) or not isinstance(metric_labels, dict):
            return fail("invalid", "malformed instance-count labels")
        if labels.get("service_name") not in ("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer") or labels.get("location") != region:
            continue
        revision, state = labels.get("revision_name"), metric_labels.get("state")
        if not valid_id(revision) or state not in ("active", "idle") or not isinstance(item.get("points"), list):
            return fail("invalid", "invalid instance-count identity")
        for point in item["points"]:
            if not isinstance(point, dict) or not isinstance(point.get("interval"), dict) or not isinstance(point.get("value"), dict):
                return fail("invalid", "malformed instance-count point")
            stamp = point["interval"].get("endTime")
            at = epoch(stamp)
            value = point["value"].get("int64Value")
            if at is None or at > end or not isinstance(value, str) or not value.isdigit() or len(value) > 19:
                return fail("invalid", "invalid or future instance-count sample")
            result.setdefault(revision, {}).setdefault(state, []).append((at, int(value), stamp))
    return Result(result)


def latest_zeroes(states):
    zeroes = {}
    for state in ("active", "idle"):
        points = states.get(state, [])
        if points:
            _, value, stamp = max(points)
            if value == 0:
                zeroes[state] = stamp
    return zeroes if len(zeroes) == 2 else {}


def unresolved_positive(states):
    return any(value > 0 for points in states.values() for _, value, _ in points) and not latest_zeroes(states)


def revision_resources(cloud, record, services):
    names = set()
    for service in services:
        revisions = cloud.json(["run", "revisions", "list", "--service", service, "--project", record["project"], "--region", record["region"]])
        if revisions.error:
            return revisions
        if not isinstance(revisions.value, list):
            return fail("invalid", "malformed revision inventory")
        for revision in revisions.value:
            metadata = revision.get("metadata") if isinstance(revision, dict) else None
            name = metadata.get("name") if isinstance(metadata, dict) else None
            if not valid_id(name):
                return fail("invalid", "invalid revision name")
            names.add(name)
    return Result(sorted(names))


def inventory(cloud, record, wall=now, services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")):
    resources = revision_resources(cloud, record, services)
    if resources.error:
        return resources
    boundary = wall()
    at = epoch(boundary)
    if at is None:
        return fail("invalid", "invalid inventory clock")
    start = datetime.fromtimestamp(at - 900, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    observed = metrics(cloud, record["project"], record["region"], start, boundary, services)
    if observed.error:
        return observed
    parsed = samples(observed.value, record["region"], epoch(boundary))
    if parsed.error:
        return parsed
    names = set()
    excluded = {}
    for revision, states in parsed.value.items():
        if unresolved_positive(states):
            names.add(revision)
        elif any(value > 0 for points in states.values() for _, value, _ in points):
            excluded[revision] = latest_zeroes(states)
    operations = pending_operations(cloud, record["project"])
    if operations.error:
        return operations
    record["retirement"] = {"after": boundary, "resources": resources.value, "resourcesRetired": False, "revisions": sorted(names), "zeroes": {}, "excluded": excluded, "operations": operations.value}
    return Result(record)


def evidence(record, series, end):
    if not valid_retirement(record["retirement"]) or record["retirement"] is None or epoch(end) is None:
        return fail("invalid", "invalid retirement record or clock")
    parsed = samples(series, record["region"], epoch(end))
    if parsed.error:
        return parsed
    current = next((item["revision"] for item in record["serving"] or [] if item["service"] == "pi-orb-issuer"), None)
    retirement = record["retirement"]
    targets = set(retirement["revisions"])
    excluded = {revision: dict(states) for revision, states in retirement["excluded"].items()}
    for revision, states in excluded.copy().items():
        if any(epoch(stamp) > epoch(end) for stamp in states.values()):
            return fail("invalid", "future excluded retirement evidence")
        observed = parsed.value.get(revision, {})
        if any(value > 0 and at >= epoch(states[state]) for state, points in observed.items() for at, value, _ in points):
            del excluded[revision]
            targets.add(revision)
        else:
            excluded[revision] = latest_zeroes({state: observed.get(state, []) + [(epoch(stamp), 0, stamp)]
                                                for state, stamp in states.items()})
    for revision, states in parsed.value.items():
        if revision == current or revision in targets or revision in excluded:
            continue
        if unresolved_positive(states):
            targets.add(revision)
        elif any(value > 0 for points in states.values() for _, value, _ in points):
            excluded[revision] = latest_zeroes(states)
    if current in targets:
        return fail("conflict", "retirement inventory includes the serving browser")
    after = epoch(retirement["after"])
    zeroes = {}
    for revision in sorted(targets):
        observed = parsed.value.get(revision, {})
        complete = latest_zeroes(observed)
        positives = [at for points in observed.values() for at, value, _ in points if value > 0]
        if complete and positives and any(epoch(stamp) < after for stamp in complete.values()) and all(epoch(stamp) >= max(positives) for stamp in complete.values()):
            targets.remove(revision)
            excluded[revision] = complete
            continue
        states = {}
        for state in ("active", "idle"):
            # A prior explicit zero remains proof for a deleted revision unless
            # a newer positive sample refutes it. This supports validation-only
            # operation long after Cloud Monitoring stops emitting that series.
            saved = retirement["zeroes"].get(revision, {}).get(state)
            points = list(parsed.value.get(revision, {}).get(state, []))
            if saved is not None:
                at = epoch(saved)
                if at is None or at < after or at > epoch(end):
                    return fail("invalid", "invalid stored retirement evidence")
                points.append((at, 0, saved))
            if points:
                at, value, stamp = max(points)
                if at >= after and value == 0:
                    states[state] = stamp
        if len(states) == 2:
            zeroes[revision] = states
    return Result({**retirement, "revisions": sorted(targets), "zeroes": zeroes, "excluded": excluded})


def pending_operations(cloud, project):
    listed = cloud.json(["compute", "operations", "list", "--project", project, "--filter=status!=DONE"])
    if listed.error:
        return listed
    if not isinstance(listed.value, list):
        return fail("invalid", "malformed compute operation inventory")
    pending = []
    for operation in listed.value:
        if not isinstance(operation, dict) or not isinstance(operation.get("targetLink"), str):
            return fail("invalid", "compute operation has no target identity")
        target = operation["targetLink"]
        if f"/projects/{project}/" in target and re.search(r"/(instances|disks|images)/pi-orb-", target):
            if not valid_id(operation.get("name")):
                return fail("invalid", "compute operation has no valid name")
            if operation.get("status") != "DONE":
                pending.append(operation["name"])
    return Result(sorted(pending))


def wait_for_retirement(cloud, record, *, wall=now, monotonic=time.monotonic, sleep=time.sleep, checkpoint=lambda _record: Result(), limit=75 * 60, services=None):
    if record["retirement"] is None:
        return fail("invalid", "retirement inventory is required")
    deadline = monotonic() + limit
    visible_after = monotonic() if record['retirement']['resourcesRetired'] else None
    previous = None
    while True:
        scope_services = services or ("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")
        resources = revision_resources(cloud, record, scope_services)
        if resources.error:
            return resources
        current = {item['revision'] for item in record['serving'] or []}
        remaining = (set(resources.value) - current) | (set(resources.value) & set(record['retirement']['resources']))
        if remaining:
            record['retirement']['resourcesRetired'] = False
            stored = checkpoint(record)
            if stored.error:
                return stored
            return fail("conflict", "old revision resources can still reactivate: " + ", ".join(sorted(remaining)))
        if visible_after is None:
            visible_after = monotonic() + INSTANCE_COUNT_VISIBILITY_SECONDS
        record['retirement']['resourcesRetired'] = monotonic() >= visible_after
        end = wall()
        scope = {} if services is None else {"services": services}
        start = datetime.fromtimestamp(epoch(record['retirement']['after']) - 900, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        observed = metrics(cloud, record["project"], record["region"], start, end, **scope)
        if observed.error:
            return observed
        found = evidence(record, observed.value, end)
        if found.error:
            return found
        record["retirement"] = found.value
        pending = sorted(set(found.value["revisions"]) - set(found.value["zeroes"]))
        if not pending:
            operations = pending_operations(cloud, record["project"])
            if operations.error:
                return operations
            record["retirement"]["operations"] = operations.value
        waiting = (pending, record["retirement"]["operations"], record['retirement']['resourcesRetired'])
        if waiting != previous:
            stored = checkpoint(record)
            if stored.error:
                return stored
            print("release: waiting for old application processes: " + (", ".join(pending) or "none"), flush=True)
            if record["retirement"]["operations"]:
                print("release: waiting for compute operations: " + ", ".join(record["retirement"]["operations"]), flush=True)
            if not record['retirement']['resourcesRetired']:
                print("release: waiting for instance-count metric visibility", flush=True)
            previous = waiting
        if not pending and not record["retirement"]["operations"] and record['retirement']['resourcesRetired']:
            return Result(record)
        if monotonic() >= deadline:
            stored = checkpoint(record)
            return stored if stored.error else fail("timeout", "old application retirement is not proven; activation remains gated")
        sleep(max(0, min(15, deadline - monotonic())))


def main(argv):
    if len(argv) != 3 or argv[1] not in ("inventory", "wait"):
        print("usage: python3 -m infra.release_retire <inventory|wait> RECORD", file=sys.stderr)
        return 2
    record = load(argv[2])
    if record.error or not validate_record(record.value):
        print("release: invalid retirement record", file=sys.stderr)
        return 1
    cloud = Cloud()
    def checkpoint(value):
        stored = save(argv[2], value)
        return stored if stored.error else publish(cloud, value)
    result = inventory(cloud, record.value) if argv[1] == "inventory" else wait_for_retirement(cloud, record.value, checkpoint=checkpoint)
    if not result.error:
        result = checkpoint(result.value)
    if result.error:
        print(f"release: {result.error.kind}: {result.error.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Read-only, token-free rollout evidence owned by the external Deploy runner."""
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from infra.release_state import Cloud, Result, fail, load, now, parse_json, save, valid_id

WINDOW_SECONDS = 900
METRIC_LAG_SECONDS = 180
ID_TOKEN_RETRY_SECONDS = 10


def placement(service, image):
    try:
        container = service['spec']['template']['spec']['containers'][0]
        env = {entry['name']: entry.get('value') for entry in container['env']}
        revision = service['status']['latestReadyRevisionName']
    except (KeyError, TypeError, IndexError):
        return fail('invalid', 'service configuration unavailable')
    if not valid_id(revision):
        return fail('invalid', 'invalid serving revision')
    if container['image'] != image:
        return fail('conflict', 'serving image changed')
    return Result({'revision': revision,
                   'generation': env.get('PI_ORB_HOST_SPEC_GENERATION')})


def id_token_attempt(row, project, region, revision):
    """Only native request logs can establish an HTTP outcome, not container JSON."""
    trace = row.get('trace')
    resource = row.get('resource', {})
    labels = resource.get('labels', {}) if isinstance(resource, dict) else None
    if (row.get('logName') != f'projects/{project}/logs/run.googleapis.com%2Frequests' or
            not isinstance(trace, str) or
            not re.fullmatch(re.escape(f'projects/{project}/traces/') + r'[a-f0-9]{32}', trace) or
            trace.endswith('/' + '0' * 32) or not isinstance(resource, dict) or
            resource.get('type') != 'cloud_run_revision' or not isinstance(labels, dict) or
            labels.get('service_name') != 'pi-orb-issuer' or
            labels.get('location') != region or labels.get('revision_name') != revision):
        return None
    request = row.get('httpRequest', {})
    url, stamp = request.get('requestUrl'), row.get('timestamp')
    if request.get('requestMethod') != 'POST' or not isinstance(url, str) or not isinstance(stamp, str):
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
        timestamp = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    if (parsed.scheme != 'https' or not parsed.netloc or parsed.path != '/runtime/v1/id-token' or
            parsed.query or parsed.fragment or timestamp.tzinfo is None):
        return None
    return trace, url, timestamp


def log_counts(rows, successes=(), project=None, region=None, revision=None):
    throttles = [(row, id_token_attempt(row, project, region, revision)) for row in rows
                 if row.get('httpRequest', {}).get('status') == 429]
    completed = [id_token_attempt(row, project, region, revision) for row in successes
                 if row.get('httpRequest', {}).get('status') == 200]
    first = {}
    for _, attempt in throttles:
        if attempt:
            key = attempt[:2]
            first[key] = min(first.get(key, attempt[2]), attempt[2])
    recovered = [row for row, attempt in throttles if attempt and any(
        success and success[:2] == attempt[:2] and attempt[2] < success[2] <=
        first[attempt[:2]] + timedelta(seconds=ID_TOKEN_RETRY_SECONDS) for success in completed)]
    errors = [row for row in rows if row.get('severity') in ('ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY')]
    # Eligible 429s are provisional even at ERROR severity; the final throttle
    # classification decides them. Independent application errors remain sticky.
    pending_or_recovered = [row for row, attempt in throttles if attempt]
    return {'errorsRaw': len(errors),
            'errors': sum(row not in pending_or_recovered for row in errors),
            'http429': len(throttles), 'http429Recovered': len(recovered),
            'http429Unrecovered': len(throttles) - len(recovered),
            'http5xx': sum(type(row.get('httpRequest', {}).get('status')) is int and
                          row['httpRequest']['status'] >= 500 for row in rows)}


def read_logs(cloud, project, query):
    logs = cloud.json(['logging', 'read', query, '--project', project, '--limit=1000'])
    if logs.error:
        return logs
    if (not isinstance(logs.value, list) or len(logs.value) >= 1000 or
            any(not isinstance(row, dict) or
                not isinstance(row.get('jsonPayload', {}), dict) or
                not isinstance(row.get('resource', {}), dict) or
                not isinstance(row.get('resource', {}).get('labels', {}), dict) or
                not isinstance(row.get('httpRequest', {}), dict) for row in logs.value)):
        return fail('invalid', 'error log inventory truncated')
    return logs


def rollout_logs(cloud, project, region, revision, start):
    cutoff = datetime.fromisoformat(start.replace('Z', '+00:00')) + timedelta(seconds=WINDOW_SECONDS)
    recovery_end = (cutoff + timedelta(seconds=ID_TOKEN_RETRY_SECONDS)).isoformat().replace('+00:00', 'Z')
    scope = (f'resource.type="cloud_run_revision" AND resource.labels.service_name="pi-orb-issuer" '
             f'AND resource.labels.location="{region}" AND resource.labels.revision_name="{revision}" '
             f'AND timestamp>="{start}"')
    # NOT also matches application logs with no HTTP status; != would drop them.
    logs = read_logs(cloud, project, scope +
                     f' AND ((httpRequest.status=429 AND timestamp<="{cutoff.isoformat().replace("+00:00", "Z")}") OR '
                     '((NOT httpRequest.status=429) AND '
                     '(severity>=ERROR OR httpRequest.status>=500 OR textPayload:"lifecycle:")))')
    if logs.error:
        return logs
    traces = sorted({attempt[0] for row in logs.value
                     if row.get('httpRequest', {}).get('status') == 429 and
                     (attempt := id_token_attempt(row, project, region, revision))})
    successes = []
    # Keep each query below Logging's 20,000-character filter limit.
    for offset in range(0, len(traces), 100):
        matches = ' OR '.join(f'trace="{trace}"' for trace in traces[offset:offset + 100])
        completed = read_logs(cloud, project, scope + f' AND timestamp<="{recovery_end}" '
                              f'AND logName="projects/{project}/logs/run.googleapis.com%2Frequests" '
                              f'AND httpRequest.requestMethod="POST" AND httpRequest.status=200 AND ({matches})')
        if completed.error:
            return completed
        successes.extend(completed.value)
    return Result({'counts': log_counts(logs.value, successes, project, region, revision),
                   'lifecycle': lifecycle_counts(logs.value)})


def lifecycle_counts(rows):
    counts = {}
    events = {'central-agent-unavailable', 'central-delivery-blocked', 'drain-blocked',
              'drain-integrity', 'drain-restart-cap', 'compute-discard',
              'compute-discard-requested', 'central-agent-start-rejected',
              'agent.startup_cleanup_failed', 'agent.owner_lost'}
    for row in rows:
        text = row.get('textPayload', '')
        if not isinstance(text, str):
            continue
        match = re.search(r'lifecycle: (?:orb=[\w-]+ )?([\w.-]+)(?: |$)', text)
        if not match or match[1] not in events:
            continue
        code = re.search(r'\bcode=(history_integrity)(?: |$)', text)
        key = code[1] if code else match[1]
        counts[key] = counts.get(key, 0) + 1
    return counts


def metric_coverage(cloud, project, resource, metric, start, end, required=True, region=None, revision=None):
    query = {'filter': f'metric.type="{metric}" AND resource.type="{resource}"',
             'interval.startTime': start, 'interval.endTime': end, 'view': 'FULL', 'pageSize': '1000'}
    if resource == 'cloudsql_database':
        query['filter'] += f' AND resource.labels.database_id="{project}:pi-orb"'
    else:
        query['filter'] += ' AND resource.labels.service_name="pi-orb-issuer"'
        if region is not None:
            query['filter'] += f' AND resource.labels.location="{region}"'
        if revision is not None:
            query['filter'] += f' AND resource.labels.revision_name="{revision}"'
    stamps, values, counts, series, seen = [], [], [], 0, set()
    for _ in range(10):
        page = cloud.http('GET', f'https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?' + urllib.parse.urlencode(query))
        if page.error:
            return page
        if not isinstance(page.value, dict) or not isinstance(page.value.get('timeSeries', []), list):
            return fail('invalid', 'invalid metric response')
        for item in page.value.get('timeSeries', []):
            if not isinstance(item, dict) or not isinstance(item.get('points'), list):
                return fail('invalid', 'invalid metric points')
            series += 1
            for point in item['points']:
                stamp = point.get('interval', {}).get('endTime') if isinstance(point, dict) else None
                if not isinstance(stamp, str):
                    return fail('invalid', 'missing metric timestamp')
                value = point.get('value', {})
                raw = value.get('doubleValue', value.get('int64Value'))
                if isinstance(value.get('distributionValue'), dict):
                    distribution = value['distributionValue']
                    raw = distribution.get('mean')
                    count = distribution.get('count')
                    if isinstance(count, str) and count.isdigit():
                        counts.append(int(count))
                if raw is not None:
                    try:
                        number = float(raw)
                    except (TypeError, ValueError):
                        return fail('invalid', 'invalid metric value')
                    if not math.isfinite(number):
                        return fail('invalid', 'invalid metric value')
                    values.append(number)
                stamps.append(stamp)
        token = page.value.get('nextPageToken', '')
        if token == '':
            if required and (not stamps or not values):
                return fail('http', 'required metrics unavailable')
            return Result({'series': series, 'points': len(stamps),
                           'latestAt': max(stamps) if stamps else None,
                           'minimum': min(values) if values else None,
                           'maximum': max(values) if values else None,
                           'distributionCount': sum(counts) if counts else None})
        if not isinstance(token, str) or token in seen:
            return fail('invalid', 'invalid metric pagination')
        seen.add(token)
        query['pageToken'] = token
    return fail('invalid', 'metric inventory truncated')


def api(cloud, path):
    result = cloud.run(['bash', 'infra/api.sh', path])
    return result if result.error else parse_json(result.value)




def fleet_inventory(cloud):
    projects = api(cloud, '/api/v1/projects')
    if projects.error:
        return projects
    if not isinstance(projects.value, dict) or not isinstance(projects.value.get('items'), list):
        return fail('invalid', 'project inventory unavailable')
    fleet = {}
    for project in projects.value['items']:
        project_id = project.get('id')
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', project_id):
            return fail('invalid', 'invalid project identity')
        orbs = api(cloud, '/api/v1/projects/' + project_id + '/orbs')
        if orbs.error:
            return orbs
        if not isinstance(orbs.value, dict) or not isinstance(orbs.value.get('items'), list):
            return fail('invalid', 'orb inventory unavailable')
        for orb in orbs.value['items']:
            harness, state = orb.get('harness'), orb.get('state')
            if harness not in ('pi', 'claude') or state not in (
                    'creating', 'starting', 'running', 'stopping', 'stopped', 'failed',
                    'archiving', 'archived', 'deleting'):
                return fail('invalid', 'invalid orb state')
            if (orb.get('centralAgent') is True) != (harness == 'pi'):
                return fail('conflict', 'per-orb placement mismatch')
            key = harness + ':' + state
            fleet[key] = fleet.get(key, 0) + 1
            detail = orb.get('stateDetail', {})
            phase = detail.get('type') if isinstance(detail, dict) else None
            if phase in ('draining_history', 'discarding_failed_compute', 'setup_failed'):
                fleet[phase] = fleet.get(phase, 0) + 1

    if not projects.value['items'] or not fleet:
        return fail('invalid', 'owner fleet unexpectedly empty')
    return Result({'projects': len(projects.value['items']), 'counts': fleet,
                   'ownerUserId': os.environ.get('PI_ORB_USER_ID')})


def sample(cloud, record, start):
    service = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer',
                          '--project', record['project'], '--region', record['region']])
    if service.error:
        return service
    selected = placement(service.value, record['artifacts']['control_plane_image'])
    if selected.error:
        return selected
    if selected.value['generation'] != str(record['artifacts']['deploy_generation']):
        return fail('conflict', 'serving generation changed')
    traffic = service.value.get('status', {}).get('traffic', [])
    if sum(item.get('percent', 0) for item in traffic
           if item.get('revisionName') == selected.value['revision']) != 100:
        return fail('conflict', 'serving traffic changed')
    pointer = cloud.object('pi-orb-tfstate-' + record['project'], 'static-plane/releases/active.json')
    if pointer.error:
        return pointer
    if (pointer.value is None or pointer.value['body'].get('releaseId') != record['releaseId'] or
            pointer.value['body'].get('generation') != record['artifacts']['deploy_generation']):
        return fail('conflict', 'active release changed')
    lock = cloud.object('pi-orb-tfstate-' + record['project'], 'static-plane/release.lock')
    if lock.error:
        return lock
    if lock.value is not None:
        return fail('conflict', 'release lock present after completion')
    containers = service.value['spec']['template']['spec']['containers']
    origin = next((entry.get('value') for entry in containers[0]['env']
                   if entry.get('name') == 'PI_ORB_APP_ORIGIN'), None)
    if not isinstance(origin, str) or not origin.startswith('https://'):
        return fail('invalid', 'application origin unavailable')
    os.environ['PI_ORB_APP_ORIGIN'] = origin
    try:
        with urllib.request.urlopen(origin + '/health', timeout=30) as response:
            healthy = json.load(response) == {'status': 'ok'}
    except (OSError, ValueError, urllib.error.URLError):
        return fail('http', 'health unavailable')
    if not healthy:
        return fail('conflict', 'health failed')
    sql = cloud.json(['sql', 'instances', 'describe', 'pi-orb', '--project', record['project']])
    if sql.error:
        return sql
    if not isinstance(sql.value, dict) or sql.value.get('state') != 'RUNNABLE':
        return fail('conflict', 'database not runnable')
    fleet = fleet_inventory(cloud)
    if fleet.error:
        return fleet
    baseline = record.get('_monitorBaseline', {})
    if baseline and baseline.get('ownerUserId') != fleet.value['ownerUserId']:
        return fail('conflict', 'monitor owner differs from preflight')
    logs = rollout_logs(cloud, record['project'], record['region'], selected.value['revision'], start)
    if logs.error:
        return logs
    ended = datetime.now(timezone.utc)
    # Leave the documented 180-second ingestion allowance; absence is never zero.
    metric_start = (ended - timedelta(seconds=1080)).isoformat().replace('+00:00', 'Z')
    metric_end = (ended - timedelta(seconds=180)).isoformat().replace('+00:00', 'Z')
    metrics = {}
    for label, resource, metric, required in (
            ('sqlCpu', 'cloudsql_database', 'cloudsql.googleapis.com/database/cpu/utilization', True),
            ('sqlMemory', 'cloudsql_database', 'cloudsql.googleapis.com/database/memory/utilization', True),
            ('sqlDisk', 'cloudsql_database', 'cloudsql.googleapis.com/database/disk/utilization', True),
            ('sqlConnections', 'cloudsql_database', 'cloudsql.googleapis.com/database/postgresql/num_backends', True),
            ('runInstances', 'cloud_run_revision', 'run.googleapis.com/container/instance_count', True),
            ('runCpu', 'cloud_run_revision', 'run.googleapis.com/container/cpu/utilizations', True),
            ('runMemory', 'cloud_run_revision', 'run.googleapis.com/container/memory/utilizations', True),
            ('runStarts', 'cloud_run_revision', 'run.googleapis.com/container/startup_latencies', False)):
        coverage = metric_coverage(cloud, record['project'], resource, metric, metric_start, metric_end,
                                   required, record['region'], selected.value['revision'])
        if coverage.error:
            return coverage
        metrics[label] = coverage.value
    return Result({'health': 'ok', 'placement': selected.value, 'sqlState': 'RUNNABLE',
                   'fleet': fleet.value, 'logs': logs.value['counts'],
                   'lifecycle': logs.value['lifecycle'], 'metrics': metrics})


def observe(record, output, cloud=None, clock=time.monotonic, sleep=time.sleep):
    cloud = cloud or Cloud(retry_reads=True)
    began = clock()
    evidence = {'releaseId': record.get('releaseId'), 'commit': record.get('commit'),
                'generation': record.get('artifacts', {}).get('deploy_generation'),
                'startedAt': now(), 'durationSeconds': 0, 'samples': [], 'outcome': 'observing',
                'centralInference': 'unobserved', 'metricLagSeconds': METRIC_LAG_SECONDS}
    saved = save(output, evidence)
    if saved.error:
        return saved
    failed, regression = False, False
    while True:
        final_sample = clock() - began >= WINDOW_SECONDS + ID_TOKEN_RETRY_SECONDS + METRIC_LAG_SECONDS
        captured = sample(cloud, record, evidence['startedAt'])
        if captured.error is None and any(
                entry.get('logs', {}).get('http429', 0) > captured.value.get('logs', {}).get('http429', 0)
                for entry in evidence['samples']):
            captured = fail('invalid', 'cumulative throttle log inventory decreased')
        failed = failed or captured.error is not None
        if captured.error is None:
            observed = captured.value
            regression = regression or observed.get('logs', {}).get('http5xx', 0) > 0 or (
                observed.get('logs', {}).get('errors', 0) > 0) or any(
                observed.get('lifecycle', {}).get(code, 0) > 0 for code in (
                    'history_integrity', 'drain-integrity', 'drain-restart-cap',
                    'central-agent-unavailable', 'central-delivery-blocked',
                    'agent.startup_cleanup_failed', 'agent.owner_lost'))
        evidence['samples'].append({'at': now(), 'outcome': 'unavailable', 'category': captured.error.kind,
                                    'message': captured.error.message}
                                   if captured.error else {'at': now(), 'outcome': 'observed', **captured.value})
        evidence['durationSeconds'] = int(clock() - began)
        if final_sample:
            if captured.error is None:
                regression = regression or captured.value.get('logs', {}).get('http429Unrecovered', 0) > 0
            evidence['finishedAt'] = now()
            evidence['outcome'] = 'incomplete' if failed else 'regression' if regression else 'observed'
        saved = save(output, evidence)
        if saved.error:
            return saved
        if final_sample:
            if failed or regression:
                return fail('http' if failed else 'conflict', 'rollout observation requires review')
            return Result(evidence)
        sleep(60)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--preflight':
        cloud = Cloud()
        service = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer', '--project',
                              os.environ['PROJECT'], '--region', os.environ['REGION']])
        if service.error:
            return 1
        containers = service.value.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
        origin = next((entry.get('value') for container in containers for entry in container.get('env', [])
                       if entry.get('name') == 'PI_ORB_APP_ORIGIN'), None)
        if not isinstance(origin, str) or not origin.startswith('https://'):
            return 1
        os.environ['PI_ORB_APP_ORIGIN'] = origin
        fleet = fleet_inventory(cloud)
        if fleet.error:
            print('rollout monitor preflight: owner fleet unavailable', file=sys.stderr)
            return 1
        saved = save(Path(sys.argv[2]), fleet.value)
        print('rollout monitor preflight: owner metadata inventory verified')
        return 1 if saved.error else 0
    if len(sys.argv) != 4:
        return 2
    record = load(Path(sys.argv[1]))
    if record.error or not isinstance(record.value, dict) or record.value.get('outcome') != 'validated':
        print('rollout monitor: validated release record required', file=sys.stderr)
        return 1
    baseline = load(Path(sys.argv[3]))
    if baseline.error:
        return 1
    record.value['_monitorBaseline'] = baseline.value
    result = observe(record.value, Path(sys.argv[2]))
    summary = 'rollout monitor: requires review' if result.error else 'rollout monitor: 15-minute observation retained'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write('\n' + summary + '; central inference unobserved. See rollout-monitor artifact.\n')
    return 1 if result.error else 0


if __name__ == '__main__':
    sys.exit(main())

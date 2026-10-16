#!/usr/bin/env python3
"""Read-only, token-free rollout evidence owned by the external Deploy runner."""
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from infra.release_state import Cloud, PHASES, Result, fail, load, now, parse_json, save, valid_id, validate_record, utc_epoch

WINDOW_SECONDS = 900
METRIC_LAG_SECONDS = 180


MONITOR_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)


def stop_command(child):
    try:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        finally:
            # The leader can exit and close its pipes while descendants still own the group.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.communicate()
    except OSError:
        return fail('command', 'cannot stop and join monitor command')
    return Result()


def monitor_command(args, *, data=None, timeout=120):
    child, cleanup = None, Result()
    try:
        # Defer cancellation until ownership is published; children must not inherit a blocked signal mask.
        pending = []
        previous = {received: signal.signal(received, lambda signum, _frame: pending.append(signum))
                    for received in MONITOR_SIGNALS}
        try:
            child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, start_new_session=True)
        finally:
            for received, handler in previous.items():
                signal.signal(received, handler)
            if pending:
                cancel_monitor(pending[0], None)
        output, stderr = child.communicate(input=data, timeout=timeout)
        classification = re.search(rb'\b(PERMISSION_DENIED|UNAUTHENTICATED|RESOURCE_EXHAUSTED|NOT_FOUND)\b', stderr)
        suffix = f' ({classification.group().decode()})' if classification else ''
        result = fail('command', f'{args[0]} command exited {child.returncode}{suffix}') if child.returncode else Result(output)
    except subprocess.TimeoutExpired:
        result = fail('timeout', f'{args[0]} command timed out')
    except OSError:
        result = fail('command', f'cannot execute {args[0]}')
    finally:
        if child is not None:
            previous = signal.pthread_sigmask(signal.SIG_BLOCK, MONITOR_SIGNALS)
            try:
                cleanup = stop_command(child)
                if cleanup.error:
                    print('rollout monitor: command cleanup failed', file=sys.stderr)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous)
    return cleanup if cleanup.error else result


def cancel_monitor(signum, _frame):
    for received in MONITOR_SIGNALS:
        signal.signal(received, signal.SIG_IGN)
    # CLI termination unwinds the command adapter's ownership cleanup.
    raise SystemExit(128 + signum)


def placement(service, image):
    try:
        container = service['spec']['template']['spec']['containers'][0]
        env = {entry['name']: entry.get('value') for entry in container['env']}
        revision = service['status']['latestReadyRevisionName']
    except (KeyError, TypeError, IndexError):
        return fail('invalid', 'service configuration unavailable')
    if not valid_id(revision):
        return fail('invalid', 'invalid serving revision')
    if container['image'] != image or env.get('PI_ORB_AGENT_BACKEND') != 'central-durable':
        return fail('conflict', 'serving image or Pi placement changed')
    return Result({'revision': revision, 'backend': 'central-durable',
                   'generation': env.get('PI_ORB_HOST_SPEC_GENERATION')})


def log_counts(rows):
    return {'errors': sum(row.get('severity') in ('ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY') for row in rows),
            'http429': sum(row.get('httpRequest', {}).get('status') == 429 for row in rows),
            'http5xx': sum(type(row.get('httpRequest', {}).get('status')) is int and
                          row['httpRequest']['status'] >= 500 for row in rows),
            'legacyBackend': sum(row.get('jsonPayload', {}).get('code') == 'legacy_backend' for row in rows)}


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
        code = re.search(r'\bcode=(legacy_backend|history_integrity)(?: |$)', text)
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




def fleet_inventory(cloud, central=True, fixtures=None):
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
        if (isinstance(orbs.value, dict) and isinstance(orbs.value.get('error'), dict) and
                orbs.value['error'].get('code') == 'not_found' and fixtures is not None):
            known = fixtures()
            if known.error:
                return known
            if any(item['kind'] == 'project' and item['id'] == project_id and
                   item['outcome'] in ('requested', 'created', 'deleted') for item in known.value):
                continue
        if not isinstance(orbs.value, dict) or not isinstance(orbs.value.get('items'), list):
            return fail('invalid', 'orb inventory unavailable')
        for orb in orbs.value['items']:
            harness, state = orb.get('harness'), orb.get('state')
            if harness not in ('pi', 'claude') or state not in (
                    'creating', 'starting', 'running', 'stopping', 'stopped', 'failed',
                    'archiving', 'archived', 'deleting'):
                return fail('invalid', 'invalid orb state')
            if central and (orb.get('centralAgent') is True) != (harness == 'pi'):
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


def live_record(path, expected):
    current = load(path)
    if current.error:
        return current
    if not validate_record(current.value):
        return fail('invalid', 'invalid live release record')
    if any(current.value[key] != expected.get(key) for key in
           ('releaseId', 'commit', 'project', 'region', 'artifacts', 'serving')):
        return fail('conflict', 'monitored release identity changed')
    if (current.value['artifacts'] is None or current.value['serving'] is None or
            current.value['exitCode'] is not None or
            current.value['phase'] not in ('activate', 'lifecycle', 'identity', 'complete') or
            any(value == 'failed' for value in current.value['gates'].values())):
        return fail('conflict', 'monitored release is not active')
    return current


def release_identity(cloud, record, lock_generation=None):
    pointer = cloud.object('pi-orb-tfstate-' + record['project'], 'static-plane/releases/active.json')
    if pointer.error:
        return pointer
    if (pointer.value is None or not isinstance(pointer.value.get('body'), dict) or
            pointer.value['body'].get('releaseId') != record['releaseId'] or
            pointer.value['body'].get('generation') != record['artifacts']['deploy_generation']):
        return fail('conflict', 'active release changed')
    lock = cloud.object('pi-orb-tfstate-' + record['project'], 'static-plane/release.lock')
    if lock.error:
        return lock
    if lock_generation is not None:
        if (lock.value is None or lock.value.get('generation') != lock_generation or
                not isinstance(lock.value.get('body'), dict) or
                lock.value['body'].get('releaseId') != record['releaseId'] or
                lock.value['body'].get('commit') != record['commit']):
            return fail('conflict', 'release lock ownership changed')
    elif lock.value is not None:
        return fail('conflict', 'release lock present after completion')
    return Result()


def sample(cloud, record, start):
    service = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer',
                          '--project', record['project'], '--region', record['region']])
    if service.error:
        return service
    selected = placement(service.value, record['artifacts']['control_plane_image'])
    if selected.error:
        return selected
    if not any(item['service'] == 'pi-orb-issuer' and item['revision'] == selected.value['revision']
               for item in record['serving']):
        return fail('conflict', 'serving revision changed')
    if selected.value['generation'] != str(record['artifacts']['deploy_generation']):
        return fail('conflict', 'serving generation changed')
    traffic = service.value.get('status', {}).get('traffic', [])
    if sum(item.get('percent', 0) for item in traffic
           if item.get('revisionName') == selected.value['revision']) != 100:
        return fail('conflict', 'serving traffic changed')
    identity = release_identity(cloud, record, record.get('_monitorLockGeneration'))
    if identity.error:
        return identity
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
    def fixtures():
        current = live_record(record['_monitorRecordPath'], record)
        return current if current.error else Result(current.value['fixtures'])
    fleet = fleet_inventory(cloud, fixtures=fixtures if record.get('_monitorRecordPath') else None)
    if fleet.error:
        return fleet
    baseline = record.get('_monitorBaseline', {})
    if baseline and baseline.get('ownerUserId') != fleet.value['ownerUserId']:
        return fail('conflict', 'monitor owner differs from preflight')
    logs = cloud.json(['logging', 'read',
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="pi-orb-issuer" AND resource.labels.location="{record["region"]}" AND resource.labels.revision_name="{selected.value["revision"]}" AND timestamp>="{start}" AND (severity>=ERROR OR httpRequest.status>=500 OR httpRequest.status=429 OR textPayload:"lifecycle:" OR jsonPayload.code="legacy_backend")',
        '--project', record['project'], '--limit=1000'])
    if logs.error:
        return logs
    if (not isinstance(logs.value, list) or len(logs.value) >= 1000 or
            any(not isinstance(row, dict) or
                not isinstance(row.get('jsonPayload', {}), dict) or
                not isinstance(row.get('httpRequest', {}), dict) for row in logs.value)):
        return fail('invalid', 'error log inventory truncated')
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
                   'fleet': fleet.value, 'logs': log_counts(logs.value),
                   'lifecycle': lifecycle_counts(logs.value), 'metrics': metrics})


def regressed(observed):
    return (any(observed.get('logs', {}).get(code, 0) > 0 for code in ('errors', 'http5xx', 'http429')) or
            any(observed.get('lifecycle', {}).get(code, 0) > 0 for code in (
                'history_integrity', 'drain-integrity', 'drain-restart-cap',
                'central-agent-unavailable', 'central-delivery-blocked',
                'agent.startup_cleanup_failed', 'agent.owner_lost')))


def observe(record, output, cloud=None, clock=time.monotonic, sleep=time.sleep, record_path=None):
    cloud = cloud or Cloud(run=monitor_command)
    evidence = {'releaseId': record.get('releaseId'), 'commit': record.get('commit'),
                'generation': record.get('artifacts', {}).get('deploy_generation'),
                'startedAt': now(), 'durationSeconds': 0, 'samples': [], 'outcome': 'observing',
                'centralInference': 'unobserved', 'metricLagSeconds': METRIC_LAG_SECONDS}
    saved = save(output, evidence)
    if saved.error:
        return saved
    began = clock()
    failed, regression = False, False
    while True:
        current = live_record(record_path, record) if record_path is not None else Result(record)
        if current.error:
            captured = current
        else:
            current.value.update({key: value for key, value in record.items() if key.startswith('_monitor')})
            if record_path is not None:
                current.value['_monitorRecordPath'] = record_path
            captured = sample(cloud, current.value, evidence['startedAt'])
        failed = failed or captured.error is not None
        if captured.error is None:
            regression = regression or regressed(captured.value)
        evidence['samples'].append({'at': now(), 'outcome': 'unavailable', 'category': captured.error.kind,
                                    'message': captured.error.message}
                                   if captured.error else {'at': now(), 'outcome': 'observed', **captured.value})
        evidence['durationSeconds'] = int(clock() - began)
        if evidence['durationSeconds'] >= WINDOW_SECONDS + METRIC_LAG_SECONDS:
            evidence['finishedAt'] = now()
            evidence['outcome'] = 'incomplete' if failed else 'regression' if regression else 'observed'
        saved = save(output, evidence)
        if saved.error:
            return saved
        if evidence['durationSeconds'] >= WINDOW_SECONDS + METRIC_LAG_SECONDS:
            if failed or regression:
                return fail('http' if failed else 'conflict', 'rollout observation requires review')
            return Result(evidence)
        sleep(60)


def verify(record, evidence, cloud=None):
    if (not validate_record(record) or record['outcome'] != 'validated' or
            record['phase'] != 'complete' or record['exitCode'] != 0 or
            not record['finishedAt'] or not record['gates'] or
            record['artifacts'] is None or record['serving'] is None or not record['applyAttempted'] or
            any(value != 'passed' for value in record['gates'].values()) or
            any(item['outcome'] != 'deleted' for item in record['fixtures'])):
        return fail('invalid', 'validated release and deleted fixtures required')
    required_gates = set(PHASES) - {'maintenance'}
    if record['validatesRelease'] is not None:
        required_gates -= {'checks', 'build', 'plan', 'schema', 'apply'}
    if not required_gates <= record['gates'].keys():
        return fail('invalid', 'required release gates have not passed')
    if (not isinstance(evidence, dict) or evidence.get('outcome') != 'observed' or
            utc_epoch(evidence.get('startedAt')) is None or
            type(evidence.get('durationSeconds')) is not int or
            evidence['durationSeconds'] < WINDOW_SECONDS + METRIC_LAG_SECONDS or
            evidence.get('metricLagSeconds') != METRIC_LAG_SECONDS or
            evidence.get('releaseId') != record['releaseId'] or
            evidence.get('commit') != record['commit'] or
            evidence.get('generation') != record['artifacts']['deploy_generation']):
        return fail('invalid', 'complete matching rollout observation required')
    start, end = utc_epoch(evidence['startedAt']), utc_epoch(evidence.get('finishedAt'))
    rows = evidence.get('samples')
    if (end is None or end - start < WINDOW_SECONDS + METRIC_LAG_SECONDS or
            not isinstance(rows, list) or len(rows) < 2 or
            any(not isinstance(row, dict) or row.get('outcome') != 'observed' or
                utc_epoch(row.get('at')) is None for row in rows)):
        return fail('invalid', 'complete timestamped rollout samples required')
    stamps = [utc_epoch(row['at']) for row in rows]
    if stamps != sorted(stamps) or stamps[0] < start or stamps[-1] > end or stamps[-1] - stamps[0] < WINDOW_SECONDS:
        return fail('invalid', 'rollout samples do not cover observation window')
    captured = sample(cloud or Cloud(run=monitor_command), record, evidence['startedAt'])
    if not captured.error and regressed(captured.value):
        return fail('conflict', 'final rollout observation requires review')
    return captured


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--preflight':
        cloud = Cloud(run=monitor_command)
        project, region = os.environ.get('PROJECT'), os.environ.get('REGION')
        if not valid_id(project) or not valid_id(region):
            print('rollout monitor preflight: PROJECT and REGION required', file=sys.stderr)
            return 2
        service = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer', '--project',
                              project, '--region', region])
        if service.error:
            return 1
        containers = service.value.get('spec', {}).get('template', {}).get('spec', {}).get('containers', [])
        origin = next((entry.get('value') for container in containers for entry in container.get('env', [])
                       if entry.get('name') == 'PI_ORB_APP_ORIGIN'), None)
        if not isinstance(origin, str) or not origin.startswith('https://'):
            return 1
        os.environ['PI_ORB_APP_ORIGIN'] = origin
        fleet = fleet_inventory(cloud, central=False)
        if fleet.error:
            print('rollout monitor preflight: owner fleet unavailable', file=sys.stderr)
            return 1
        saved = save(Path(sys.argv[2]), fleet.value)
        print('rollout monitor preflight: owner metadata inventory verified')
        return 1 if saved.error else 0
    if len(sys.argv) == 4 and sys.argv[1] == '--verify':
        record, evidence = load(Path(sys.argv[2])), load(Path(sys.argv[3]))
        result = record if record.error else evidence if evidence.error else verify(record.value, evidence.value)
        print(f'rollout monitor: final verification failed: {result.error.kind}: {result.error.message}' if result.error else
              'rollout monitor: validated release, observation and absent lock verified')
        return 1 if result.error else 0
    if len(sys.argv) != 6 or sys.argv[1] != '--active' or not re.fullmatch(r'[1-9][0-9]*', sys.argv[5]):
        return 2
    path = Path(sys.argv[2])
    record = load(path)
    if record.error or not validate_record(record.value):
        print('rollout monitor: valid active release record required', file=sys.stderr)
        return 1
    baseline = load(Path(sys.argv[4]))
    if baseline.error:
        return 1
    record.value['_monitorBaseline'] = baseline.value
    record.value['_monitorLockGeneration'] = sys.argv[5]
    result = observe(record.value, Path(sys.argv[3]), record_path=path)
    summary = 'rollout monitor: requires review' if result.error else 'rollout monitor: 15-minute observation plus metric lag retained'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        try:
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                stream.write('\n' + summary + '; central inference unobserved. See rollout-monitor artifact.\n')
        except OSError:
            print('rollout monitor: cannot write job summary', file=sys.stderr)
            return 1
    return 1 if result.error else 0


if __name__ == '__main__':
    for received in MONITOR_SIGNALS:
        signal.signal(received, cancel_monitor)
    sys.exit(main())

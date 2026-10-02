#!/usr/bin/env python3
"""Verify source archive and run offline checks before an explicitly opted-in guest measurement."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

archive_path = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
expected_sha = sys.argv[2] if len(sys.argv) > 2 else ''
orb_id = sys.argv[3] if len(sys.argv) > 3 else None
if archive_path is None or not archive_path.is_file() or len(expected_sha) != 64 or hashlib.sha256(archive_path.read_bytes()).hexdigest() != expected_sha:
    raise SystemExit('archive checksum mismatch')
with tempfile.TemporaryDirectory(prefix='owned-context-preflight-') as temp:
    root = pathlib.Path(temp).resolve()
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        if any(not member.isfile() or pathlib.PurePosixPath(member.name).is_absolute() or
               '..' in pathlib.PurePosixPath(member.name).parts or member.size > 40_000_000
               for member in members):
            raise SystemExit('invalid archive member')
        entries = {member.name: archive.extractfile(member).read() for member in members}
    manifest = json.loads(entries.pop('owned-context-manifest.json'))
    if set(entries) != set(manifest) or any(hashlib.sha256(value).hexdigest() != manifest[name]
                                            for name, value in entries.items()):
        raise SystemExit('manifest mismatch')
    for name, data in entries.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    env = {key: value for key, value in os.environ.items()
           if key not in {'NODE_PATH', 'NODE_OPTIONS', 'DEBUG', 'NODE_DEBUG'}
           and not key.startswith(('DEBUG_', 'NODE_DEBUG_'))}
    env['PI_TELEMETRY'] = '0'
    def command(arguments, timeout):
        return subprocess.run(arguments, cwd=root, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False).returncode == 0
    if not command(['npm', 'ci'], 600):
        raise SystemExit('dependency installation failed')
    if not command(['npm', 'ls', '--all', '--omit=dev'], 60):
        raise SystemExit('dependency graph invalid')
    tests = [f'scripts/native-mcp-exploration/live-qualification/{name}' for name in
             ('owned-context.test.mjs', 'owned-context-child.test.mjs', 'owned-context-worker.test.mjs')]
    if not command(['node', '--experimental-strip-types', '--test', *tests], 60):
        raise SystemExit('offline policy check failed')
    print(json.dumps({'preflight': 'passed', 'archiveSha256': expected_sha}))
    if orb_id is None:
        raise SystemExit(0)
    if orb_id != '9675b61b-f1e9-404a-84d3-ad79e18cea61':
        raise SystemExit('orb identity mismatch')
    script = 'scripts/native-mcp-exploration/live-qualification/owned-context.ts'
    try:
        result = subprocess.run(['node', '--experimental-strip-types', script, orb_id],
                                cwd=root, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=480, check=False)
    except subprocess.TimeoutExpired:
        raise SystemExit('measurement deadline')
    statuses = {'invalid_input', 'identity_unavailable', 'identity_mismatch',
                    'catalog_mismatch', 'workspace_unavailable', 'model_unavailable',
                    'model_auth_unavailable', 'extension_unavailable', 'session_unavailable',
                    'binding_unavailable', 'executor_unavailable', 'inference_unavailable', 'discovery_unavailable',
                    'baseline_not_empty', 'search_unavailable', 'measurement_unavailable',
                    'child_service_unavailable', 'child_spawn_unavailable', 'child_unavailable',
                    'denied_calls', 'unavailable'}
    def reject(stage, value=None):
        driver_status = value.get('status') if type(value) is dict else None
        print(json.dumps({'validationStage': stage, 'driverExitCode': result.returncode,
                          'driverStatus': driver_status if type(driver_status) is str and
                          driver_status in statuses | {'measured'} else 'unknown'}, separators=(',', ':')))
        raise SystemExit(1)
    if len(result.stdout) > 30_000:
        reject('size_limit')
    try:
        value = json.loads(result.stdout)
    except (UnicodeDecodeError, ValueError):
        reject('json_decode')
    if result.returncode:
        failure = value
        profiled = {'inference_unavailable', 'measurement_unavailable'}
        stages = {'baseline_prompt', 'baseline_discovery', 'baseline_child', 'root_prompt',
                  'root_discovery', 'root_search_prompt', 'root_after_search', 'root_child',
                  'root_child_search_gate', 'baseline_gate', 'root_gate'}
        profiles = {'root', 'child', 'independent_empty_baseline', 'baseline_child'}
        def count(value):
            return type(value) is int and 0 <= value < 100_000_000
        def valid_metric(metric):
            return (type(metric) is dict and set(metric) == {'profile', 'phase', 'kind', 'status', 'utf8Bytes', 'codepoints', 'activeMcpToolCount'}
                    and type(metric['profile']) is str and metric['profile'] in profiles
                    and type(metric['phase']) is str and metric['phase'] in {'before_discovery', 'after_discovery', 'after_search', 'invalid'}
                    and type(metric['kind']) is str and metric['kind'] in {'transcript', 'provider_payload', 'invalid'}
                    and type(metric['status']) is str and metric['status'] in {'measured', 'unavailable'}
                    and all(metric[key] is None or count(metric[key]) for key in ('utf8Bytes', 'codepoints', 'activeMcpToolCount')))
        def valid_diagnostic(value):
            if type(value) is not dict or set(value) != {'stage', 'profiles'} or (type(value['stage']) is not str or value['stage'] not in stages) or type(value['profiles']) is not list or len(value['profiles']) > 4:
                return False
            seen = set()
            for row in value['profiles']:
                if type(row) is not dict or set(row) != {'profile', 'searched', 'deniedCalls', 'deniedCategories', 'deniedSearchShape', 'completed', 'modelVerified', 'discovered', 'metrics'}:
                    return False
                if type(row['profile']) is not str or row['profile'] not in profiles or row['profile'] in seen:
                    return False
                seen.add(row['profile'])
                shape = row['deniedSearchShape']
                if shape is not None and (type(shape) is not dict or set(shape) != {'queryMatchesPolicy', 'queryObserved', 'hasLimit', 'onlyQueryAndLimit', 'limitValid'} or not all(type(v) is bool for v in shape.values())):
                    return False
                if (type(row['searched']) is not dict or set(row['searched']) != {'cloudflare account', 'datadog monitor'} or
                    not all(count(v) for v in row['searched'].values()) or
                    type(row['deniedCategories']) is not dict or set(row['deniedCategories']) != {'tool_search', 'codemode', 'other'} or
                    not all(count(v) for v in row['deniedCategories'].values()) or
                    not count(row['deniedCalls']) or type(row['completed']) is not bool or type(row['modelVerified']) is not bool or
                    type(row['discovered']) is not dict or set(row['discovered']) != {'cloudflare', 'datadog'} or
                    not all(count(v) for v in row['discovered'].values()) or type(row['metrics']) is not list or
                    len(row['metrics']) > 24 or not all(valid_metric(v) for v in row['metrics'])):
                    return False
            return True
        if (type(failure) is not dict or type(failure.get('status')) is not str or
            failure['status'] not in statuses or
            set(failure) != ({'status'} | ({'profile'} if failure['status'] in profiled and 'profile' in failure else set()) |
                             ({'diagnostic'} if 'diagnostic' in failure else set())) or
            ('profile' in failure and (type(failure['profile']) is not str or
             failure['profile'] not in {'root', 'independent_empty_baseline'})) or
            ('diagnostic' in failure and (failure['status'] not in {'workspace_unavailable', 'extension_unavailable', 'session_unavailable', 'binding_unavailable', 'executor_unavailable', 'inference_unavailable', 'discovery_unavailable', 'baseline_not_empty', 'search_unavailable', 'measurement_unavailable', 'child_service_unavailable', 'child_spawn_unavailable', 'child_unavailable', 'denied_calls'} or not valid_diagnostic(failure['diagnostic'])))):
            reject('failure_schema', failure)
        print(json.dumps(failure, separators=(',', ':')))
        raise SystemExit(1)
    try:
        assert type(value) is dict and set(value) == {'status', 'model', 'report'}
        assert value['status'] == 'measured' and value['model'] == 'openai-codex/gpt-6.1-sol'
        assert type(value['report']) is list
        assert len(value['report']) == 4
        assert {row['profile'] for row in value['report']} == {'root', 'child', 'independent_empty_baseline', 'baseline_child'}
        for row in value['report']:
            assert type(row) is dict and set(row) == {'profile', 'catalogCount', 'exposedToolCount', 'searchCount', 'searchActor', 'deniedCalls', 'metrics'}
            assert type(row['catalogCount']) is int and row['catalogCount'] in (0, 2)
            assert all(type(row[key]) is int and 0 <= row[key] < 100_000_000
                       for key in ('exposedToolCount', 'searchCount', 'deniedCalls'))
            expected_count = 36 if row['profile'] in ('root', 'child') else 0
            assert row['catalogCount'] == (2 if row['profile'] in ('root', 'child') else 0)
            assert row['exposedToolCount'] == expected_count and row['deniedCalls'] == 0
            assert row['searchCount'] == (2 if row['profile'] == 'root' else 0)
            assert row['searchActor'] == ('sdk_native_harness' if row['profile'] == 'root' else 'none')
            assert type(row['metrics']) is list and len(row['metrics']) <= 24
            expected_phase = 'after_discovery' if row['profile'] in ('root', 'child') else 'before_discovery'
            assert any(metric['kind'] == 'provider_payload' and metric['status'] == 'measured' and metric['phase'] == expected_phase
                       for metric in row['metrics'])
            if row['profile'] != 'root':
                assert all(metric['activeMcpToolCount'] == 0 for metric in row['metrics'] if metric['status'] == 'measured')
            if row['profile'] == 'root':
                assert any(metric['kind'] == 'provider_payload' and metric['status'] == 'measured' and metric['phase'] == 'after_search'
                           for metric in row['metrics'])
            else:
                assert all(metric['phase'] != 'after_search' for metric in row['metrics'])
            for metric in row['metrics']:
                assert type(metric) is dict and set(metric) == {'profile', 'phase', 'kind', 'status', 'utf8Bytes', 'codepoints', 'activeMcpToolCount'}
                assert metric['profile'] in {'root', 'child', 'independent_empty_baseline', 'baseline_child', 'invalid'}
                assert metric['phase'] in {'before_discovery', 'after_discovery', 'after_search', 'invalid'}
                assert metric['kind'] in {'transcript', 'provider_payload', 'invalid'}
                assert metric['status'] in {'measured', 'unavailable'}
                assert all(metric[key] is None or type(metric[key]) is int and 0 <= metric[key] < 100_000_000
                           for key in ('utf8Bytes', 'codepoints', 'activeMcpToolCount'))
    except (AssertionError, ValueError, KeyError, TypeError):
        reject('success_schema', value)
    print(json.dumps(value, separators=(',', ':')))

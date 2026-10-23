#!/bin/bash
set -euo pipefail
export HOME=/workspace/home
cd /workspace/repo
id
sudo -n true
expectations=${1:-/workspace/application-expectations.json}
expected_login=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["githubLogin"])' "$expectations")
expected_commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["checkoutCommit"])' "$expectations")
test -n "$expected_login"
test -n "$expected_commit"
test "$(gh api user --jq .login)" = "$expected_login"
printf 'GITHUB_BROKER_OK\n'
test "$(git rev-parse HEAD)" = "$expected_commit"
printf 'LIVE_CLONE_OK\n'
test "$NATIVE_VM_SECRET" = fixture-only-value
printf 'PROJECT_SECRET_OK\n'
mkdir -p /workspace/testcontainers-check
cd /workspace/testcontainers-check
npm install --no-audit --no-fund testcontainers@12.1.0
cat >check.mjs <<'JS'
import assert from 'node:assert/strict';
import {GenericContainer,Wait} from 'testcontainers';
const c=await new GenericContainer('busybox:1.37.0').withCommand(['sh','-c','mkdir /www; echo TESTCONTAINERS_OK >/www/index.html; exec httpd -f -p 8080 -h /www']).withExposedPorts(8080).withWaitStrategy(Wait.forHttp('/',8080)).start();
try {assert.equal((await fetch(`http://${c.getHost()}:${c.getMappedPort(8080)}`).then(r=>r.text())).trim(),'TESTCONTAINERS_OK');console.log('TESTCONTAINERS_MAPPED_HTTP_OK');}finally{await c.stop();}
JS
node check.mjs
printf workspace-sentinel >/workspace/sentinel
sync

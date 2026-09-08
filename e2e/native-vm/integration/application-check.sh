#!/bin/bash
set -euo pipefail
export HOME=/workspace/home
cd /workspace/repo
id
sudo -n true
test "$(gh api user --jq .login)" = schani
printf 'GITHUB_BROKER_OK\n'
test "$(git rev-parse HEAD)" = 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d
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

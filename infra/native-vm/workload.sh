#!/bin/bash
# Explicit seed/verify stages make retention checks independent of test ordering.
set -euo pipefail
cd /workspace/repo
case "${1:?seed or verify}" in
seed)
  mkdir -p docker-fixture
  cd docker-fixture
  cat >Dockerfile <<'EOF'
FROM alpine:3.22
RUN printf 'unpublished-image-sentinel\n' >/image-sentinel
CMD ["sleep", "infinity"]
EOF
  docker build -t native-vm-local:fixture .
  docker image inspect native-vm-local:fixture --format '{{.Id}}' >/workspace/expected-image-id
  docker run -d --name native-vm-writes native-vm-local:fixture
  docker exec native-vm-writes sh -c 'printf container-write-sentinel >/unique-write; sync'
  docker stop native-vm-writes
  docker volume create native-vm-unattached
  docker run --rm -v native-vm-unattached:/data alpine:3.22 sh -c 'printf unattached-volume-sentinel >/data/sentinel; sync'
  cat >compose.yaml <<'EOF'
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: fixture-only-password
    volumes:
      - database:/var/lib/postgresql/data
      - .:/fixture:ro
    ports:
      - "127.0.0.1:18090:5432"
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 3s
      retries: 60
volumes:
  database:
EOF
  docker compose -p native-vm-fixture up -d --wait --wait-timeout 90
  docker compose -p native-vm-fixture exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE TABLE retention (value text); INSERT INTO retention VALUES ('database-sentinel'); CHECKPOINT;"
  docker compose -p native-vm-fixture exec -T db test -f /fixture/compose.yaml
  sync
  ;;
verify)
  python3 - <<'PYWAIT'
import json, subprocess, time
deadline = time.monotonic() + 90
while True:
    state = json.loads(subprocess.check_output(['docker', 'inspect', 'native-vm-fixture-db-1']))[0]['State']
    if state.get('Running') and state.get('Health', {}).get('Status') == 'healthy':
        break
    if state.get('Health', {}).get('Status') == 'unhealthy' or time.monotonic() >= deadline:
        raise SystemExit('retained database did not restart healthy automatically')
    time.sleep(.5)
PYWAIT
  test "$(cat /workspace/sentinel)" = workspace-sentinel
  test "$(docker image inspect native-vm-local:fixture --format '{{.Id}}')" = "$(cat /workspace/expected-image-id)"
  test "$(docker inspect native-vm-writes --format '{{.State.Status}}')" = exited
  docker start native-vm-writes >/dev/null
  test "$(docker exec native-vm-writes cat /unique-write)" = container-write-sentinel
  test "$(docker exec native-vm-writes cat /image-sentinel)" = unpublished-image-sentinel
  docker stop native-vm-writes >/dev/null
  test "$(docker run --rm -v native-vm-unattached:/data alpine:3.22 cat /data/sentinel)" = unattached-volume-sentinel
  cd docker-fixture
  test "$(docker compose -p native-vm-fixture exec -T db psql -U postgres -Atc 'SELECT value FROM retention')" = database-sentinel
  docker compose -p native-vm-fixture exec -T db test -f /fixture/compose.yaml
  printf 'RETENTION_OK\n'
  ;;
*) exit 2;;
esac

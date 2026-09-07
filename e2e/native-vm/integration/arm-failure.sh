#!/bin/bash
set -euo pipefail
cd /workspace
python3 - <<'PY'
import json,os
with open('.native-integration-fail','w') as f:
 json.dump({'orbId':os.environ['PI_ORB_ID'],'incarnation':int(os.environ['PI_ORB_HOST_INCARNATION'])},f)
print('LAUNCH_FAILURE_ARMED incarnation='+os.environ['PI_ORB_HOST_INCARNATION'])
PY
sync

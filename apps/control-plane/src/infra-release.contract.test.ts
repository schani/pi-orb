import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${contents}`);
  chmodSync(path, 0o755);
}

function makeFixture(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-release-test-"));
  fixtures.push(root);
  const infra = join(root, "infra");
  const bin = join(root, "bin");
  const scratch = join(root, "tmp");
  const log = join(root, "calls.log");
  mkdirSync(infra);
  mkdirSync(join(infra, "foundation"));
  mkdirSync(bin);
  mkdirSync(scratch);
  copyFileSync(resolve("infra/release.sh"), join(infra, "release.sh"));
  copyFileSync(resolve("infra/release-child.sh"), join(infra, "release-child.sh"));
  copyFileSync(resolve("infra/check-database-plan.jq"), join(infra, "check-database-plan.jq"));
  executable(join(infra, "api.sh"), `echo '{"hostProvider":"gce"}'\n`);
  executable(
    join(bin, "python3"),
    `node - "$@" <<'NODE'
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, 'record:' + a.join(' ') + '\\n');
if (a[0] !== '-m' || a[1] !== 'infra.release_state') process.exit(0);
const [action, path, ...rest] = a.slice(2);
if (action === 'init') fs.writeFileSync(path, JSON.stringify({commit:rest[1],phase:'preflight',artifacts:{control_plane_image:'registry/control@sha256:abc',deploy_generation:201}}));
if (action === 'preflight-vars') fs.writeFileSync(rest[0], 'deploy_generation = 200\\n');
if (action === 'stage') {
 const record = JSON.parse(fs.readFileSync(path));
 record.phase = rest[0]; fs.writeFileSync(path, JSON.stringify(record));
}
NODE
`,
  );
  chmodSync(join(infra, "release.sh"), 0o755);

  executable(
    join(bin, "git"),
    `case "$1" in
  status) exit 0 ;;
  branch) echo main ;;
  fetch) exit 0 ;;
  rev-parse) echo abc123 ;;
  *) exit 1 ;;
esac\n`,
  );
  executable(join(bin, "docker"), 'test "$1" = info\n');
  executable(join(bin, "uuidgen"), "echo 00000000-0000-4000-8000-000000000001\n");
  executable(join(bin, "npm"), 'echo "npm:$*" >> "$CALL_LOG"\n');
  executable(
    join(bin, "gcloud"),
    `echo "gcloud:$*" >> "$CALL_LOG"
if [ "$1" = auth ]; then echo token; exit 0; fi
if [ "$1 $2" = "storage cp" ]; then exit "\${MOCK_LOCK_STATUS:-0}"; fi
if [ "$1 $2 $3" = "storage objects describe" ]; then echo 42; exit 0; fi
if [ "$1 $2" = "storage rm" ]; then exit 0; fi
if [ "$1 $2 $3" = "secrets versions describe" ]; then echo projects/test/secrets/database/versions/1; exit 0; fi
if [ "$1 $2 $3" = "run jobs create" ]; then exit "\${MOCK_SCHEMA_STATUS:-0}"; fi
cat <<'JSON'
{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"PI_ORB_HOST_SPEC_GENERATION","value":"200"}]}]}}}}
JSON
`,
  );
  executable(
    join(bin, "tofu"),
    `echo "tofu:$*" >> "$CALL_LOG"
for arg in "$@"; do
  case "$arg" in
    -out=*)
      plan="\${arg#-out=}"
      touch "$plan"
      case "$(uname -s)" in
        Darwin) mode=$(stat -f %Lp "$plan") ;;
        *) mode=$(stat -c %a "$plan") ;;
      esac
      echo "plan-mode:$mode" >> "$CALL_LOG"
      ;;
  esac
done
case "$*" in
  *" show -json "*)
    action=no-op
    if [ "\${MOCK_DATABASE_PLAN_STATUS:-}" = replace ]; then action=delete; fi
    cat <<JSON
{"resource_changes":[
  {"address":"google_sql_database_instance.pi_orb","change":{"actions":["$action"]}},
  {"address":"google_sql_database.pi_orb","change":{"actions":["no-op"]}},
  {"address":"google_sql_user.pi_orb","change":{"actions":["no-op"]}},
  {"address":"random_password.db","change":{"actions":["no-op"]}},
  {"address":"google_secret_manager_secret.database_url","change":{"actions":["no-op"]}},
  {"address":"google_secret_manager_secret_version.database_url","change":{"actions":["no-op"]}}
]}
JSON
    ;;
  *" apply "*)
    if [ "\${MOCK_APPLY_SIGNAL:-}" = TERM ]; then kill -TERM "$PPID"; sleep 0.1; exit 143; fi
    exit "\${MOCK_APPLY_STATUS:-0}"
    ;;
  *"foundation output -json"*)
    if [ "\${MOCK_FOUNDATION_STATUS:-}" = missing ]; then echo '{}'; else
      cat <<JSON
{"foundation_schema_version":{"value":1},"project":{"value":"$PROJECT"},"region":{"value":"$REGION"},"zone":{"value":"us-central1-a"},"image_builder_service_account_email":{"value":"builder@example.com"},"image_build_subnetwork":{"value":"projects/test-project/regions/us-central1/subnetworks/pi-orb-image-build"},"pi_orb_network":{"value":"projects/test-project/global/networks/pi-orb"},"orb_subnetwork_resource":{"value":"regions/us-central1/subnetworks/pi-orb-us-central1"},"run_egress_subnetwork":{"value":"projects/test-project/regions/us-central1/subnetworks/pi-orb-run-egress"},"run_egress_cidr":{"value":"10.10.16.0/26"},"control_plane_service_account_email":{"value":"cp@example.com"},"trusted_pi_orb_project_id":{"value":"trusted-project"},"pi_orb_workload_identity_provider":{"value":"projects/123/locations/global/workloadIdentityPools/orbs/providers/pi"},"deployer_service_account_email":{"value":"deployer@example.com"}}
JSON
    fi
    ;;
  *"output -raw zone"*) echo us-central1-a ;;
  *"output -raw ops_url"*) echo https://ops.example ;;
  *"output -raw issuer_url"*) echo https://issuer.example ;;
esac
`,
  );
  executable(
    join(infra, "build-push.sh"),
    `echo build >> "$CALL_LOG"
cat <<'VARS'
control_plane_image = "registry/control@sha256:abc"
native_image_resource = "projects/test/global/images/pi-orb-test"
native_image_id = "12345"
workspace_image_resource = "projects/test/global/images/pi-orb-workspace-test"
workspace_image_id = "22345"
deploy_generation   = 100
VARS
`,
  );
  executable(join(infra, "deploy.sh"), 'echo "deploy:$*" >> "$CALL_LOG"\n');
  executable(join(infra, "smoke.sh"), 'echo smoke >> "$CALL_LOG"\n');
  executable(
    join(infra, "smoke-workload-identity.sh"),
    // Both required inputs must reach it, or the real script exits at its own
    // preflight (docs/workload-identity.md).
    'echo "wif-smoke:$PI_ORB_GCP_PROJECT:$PI_ORB_GCE_ZONE" >> "$CALL_LOG"\n',
  );

  return { root, log };
}

function makeDeployFixture(): { root: string; log: string; policy: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-deploy-test-"));
  fixtures.push(root);
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const policy = join(root, "applied-policy.json");
  mkdirSync(bin);
  copyFileSync(resolve("infra/deploy.sh"), join(root, "deploy.sh"));
  chmodSync(join(root, "deploy.sh"), 0o755);
  executable(
    join(bin, "gcloud"),
    `echo "gcloud:$*" >> "$CALL_LOG"
case "$1 $2 $3 $4" in
  "run services update pi-orb") exit 0 ;;
  "beta iap web get-iam-policy")
    if [ -f "$POLICY_FILE" ]; then cat "$POLICY_FILE"; else
      cat <<'JSON'
{"bindings":[{"role":"roles/iap.httpsResourceAccessor","members":["domain:heyglide.com","serviceAccount:debug@example.com"]},{"role":"roles/viewer","members":["user:operator@example.com"]}],"etag":"etag-1","version":1}
JSON
    fi
    ;;
  "beta iap web set-iam-policy") cp "$5" "$POLICY_FILE" ;;
  "run services describe pi-orb")
    if env | grep '^MOCK_SERVICE_STATUS=' >/dev/null; then printenv MOCK_SERVICE_STATUS; else
      cat <<'JSON'
{"status":{"latestReadyRevisionName":"serving-revision","traffic":[{"tag":"files","latestRevision":true,"percent":100,"revisionName":"serving-revision"}]}}
JSON
    fi
    ;;
  "run revisions list --service") printf 'serving-revision\\nold-revision\\n' ;;
  "run revisions delete old-revision") exit 0 ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 1 ;;
esac
`,
  );
  return { root, log, policy };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

describe("infra/deploy.sh", () => {
  it("reconciles the exact IAP accessor allowlist before pruning revisions", () => {
    const { root, log, policy } = makeDeployFixture();
    const result = spawnSync(join(root, "deploy.sh"), [], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        POLICY_FILE: policy,
        TMPDIR: root,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const applied = JSON.parse(readFileSync(policy, "utf8")) as {
      bindings: Array<{ members: string[]; role: string }>;
      etag: string;
    };
    expect(
      applied.bindings.find((binding) => binding.role === "roles/iap.httpsResourceAccessor"),
    ).toEqual({ members: ["domain:heyglide.com"], role: "roles/iap.httpsResourceAccessor" });
    expect(applied.bindings.find((binding) => binding.role === "roles/viewer")).toEqual({
      members: ["user:operator@example.com"],
      role: "roles/viewer",
    });
    expect(applied.etag).toBe("etag-1");
    const calls = readFileSync(log, "utf8");
    const describe =
      "gcloud:run services describe pi-orb --project playground-dev-6ae7 --region us-central1 --format=json";
    expect(calls).toContain(describe);
    expect(calls.indexOf("beta iap web set-iam-policy")).toBeLessThan(calls.indexOf(describe));
    expect(calls.lastIndexOf("beta iap web get-iam-policy")).toBeLessThan(calls.indexOf(describe));
    expect(calls.indexOf(describe)).toBeLessThan(
      calls.indexOf("run revisions delete old-revision"),
    );
  });

  it.each([
    [
      "missing",
      {
        status: {
          latestReadyRevisionName: "serving-revision",
          traffic: [{ latestRevision: true, percent: 100, revisionName: "serving-revision" }],
        },
      },
    ],
    [
      "misrouted",
      {
        status: {
          latestReadyRevisionName: "serving-revision",
          traffic: [
            {
              tag: "files",
              latestRevision: false,
              percent: 100,
              revisionName: "old-revision",
            },
          ],
        },
      },
    ],
  ])("refuses a %s files traffic route before pruning revisions", (_name, serviceStatus) => {
    const { root, log, policy } = makeDeployFixture();
    const result = spawnSync(join(root, "deploy.sh"), [], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        POLICY_FILE: policy,
        MOCK_SERVICE_STATUS: JSON.stringify(serviceStatus),
        TMPDIR: root,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not route the files tag");
    expect(readFileSync(log, "utf8")).not.toContain("run revisions delete");
  });

  it("repairs IAP only without requiring the application traffic route", () => {
    const { root, log, policy } = makeDeployFixture();
    const result = spawnSync(join(root, "deploy.sh"), ["--iap-only"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        POLICY_FILE: policy,
        MOCK_SERVICE_STATUS: "{}",
        TMPDIR: root,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("run services describe");
  });
});

describe("workload-identity cloud release configuration", () => {
  it("uses the deterministic issuer origin as the trust anchor", () => {
    const run = readFileSync(resolve("infra/run.tf"), "utf8");
    const outputs = readFileSync(resolve("infra/outputs.tf"), "utf8");

    expect(run).toMatch(/condition\s+=\s+contains\(self\.urls, local\.oidc_issuer_url\)/);
    expect(run).not.toContain("self.uri == local.oidc_issuer_url");
    expect(outputs).toMatch(/output "issuer_url"[\s\S]*value\s+=\s+local\.oidc_issuer_url/);
    expect(outputs).not.toMatch(
      /output "issuer_url"[\s\S]*value\s+=\s+google_cloud_run_v2_service\.issuer\.uri/,
    );
  });

  it("owns an IAP-only SSH path for the live smoke", () => {
    const network = readFileSync(resolve("infra/network.tf"), "utf8");
    const smoke = readFileSync(resolve("infra/smoke-workload-identity.sh"), "utf8");

    expect(network).toMatch(
      /resource "google_compute_firewall" "iap_to_orb_ssh"[\s\S]*source_ranges\s+=\s+\["35\.235\.240\.0\/20"\][\s\S]*target_service_accounts\s+=\s+\[local\.orb_vm_email, local\.image_builder_email\][\s\S]*ports\s+=\s+\["22"\]/,
    );
    expect(smoke).toContain("--tunnel-through-iap --quiet");
    expect(smoke).toContain('wait_for_ssh "$MINT_INSTANCE"');
    expect(smoke).toContain("sed 's/^/  /' \"$WORK_DIR/mint.err\"");
  });

  it("extracts instance metadata locally from describe JSON", () => {
    const smoke = readFileSync(resolve("infra/smoke-workload-identity.sh"), "utf8");
    const helper = smoke.match(/instance_metadata\(\)[\s\S]*?\n}\n\norb_ssh\(\)/)?.[0];

    expect(helper).toBeDefined();
    expect(helper).toContain("gcloud compute instances describe");
    expect(helper).toContain("--format=json");
    expect(helper).toContain("JSON.parse(input)");
    expect(helper).not.toContain("--filter");
  });
});

describe("infra/release.sh", () => {
  it("runs the complete release in order and clamps the generation forward", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("generation 201");
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(
      /gcloud:storage cp[\s\S]*tofu:.* init[\s\S]*tofu:.* plan[\s\S]*\nbuild[\s\S]*tofu:.* plan[\s\S]*run jobs create[\s\S]*tofu:.* apply[\s\S]*deploy:[\s\S]*infra.release_retire wait[\s\S]*infra.release_state activate[\s\S]*smoke[\s\S]*wif-smoke[\s\S]*gcloud:storage rm/,
    );
    // The workload-identity smoke runs inside the lock, after the lifecycle
    // smoke, and is handed the project and zone its GCE legs need.
    expect(calls).toContain("wif-smoke:test-project:us-central1-a");
    expect(calls).toContain("plan-mode:600");
    expect(calls).not.toContain("--iap-only");
    const planPath = calls.match(/tofu:.* plan .* -out=([^ ]*\/release\.tfplan)/)?.[1];
    expect(planPath).toBeDefined();
    expect(calls).toContain(`tofu:-chdir=${join(root, "infra")} apply -input=false ${planPath}`);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it("validation-only neither builds, migrates nor applies", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--validate", "release-original"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("release-original");
    expect(calls).toContain("infra.release_state activate");
    expect(calls).toContain("wif-smoke");
    expect(calls).not.toMatch(/\nbuild\n|tofu:.* plan |tofu:.* apply |run jobs create/);
  });

  it("retains the global lock after an uncertain migration job", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_SCHEMA_STATUS: "7",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lock retained");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toMatch(/tofu:.* apply |gcloud:storage rm|\nwif-smoke/);
    expect(calls).toContain("--max-retries=0");
    expect(calls).toContain("--wait");
  });

  it("repairs IAP, skips smoke, and preserves a failed apply status", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_APPLY_STATUS: "7",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });

    expect(result.status).toBe(7);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("deploy:--iap-only");
    expect(calls).not.toContain("smoke");
    expect(calls).toContain("gcloud:storage rm");
  });

  it("refuses a saved plan that changes the database or its credentials", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_DATABASE_PLAN_STATUS: "replace",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("saved plan does not preserve the database");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain(" apply ");
    expect(calls).not.toContain("smoke");
  });

  it("repairs IAP and releases the global lock when apply is interrupted", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_APPLY_SIGNAL: "TERM",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });

    expect(result.status).toBe(143);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("deploy:--iap-only");
    expect(calls).not.toContain("smoke");
    expect(calls).toContain("gcloud:storage rm");
  });

  it("refuses release before build when the foundation is not applied", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_FOUNDATION_STATUS: "missing",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apply/adopt the matching foundation");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("\nbuild\n");
    expect(calls).not.toContain(" apply ");
    expect(calls).toContain("gcloud:storage rm");
  });

  it("does not build when another release holds the global lock", () => {
    const { root, log } = makeFixture();
    const result = spawnSync(join(root, "infra/release.sh"), ["--yes"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALL_LOG: log,
        MOCK_LOCK_STATUS: "1",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PROJECT: "test-project",
        TMPDIR: join(root, "tmp"),
      },
    });

    expect(result.status).toBe(1);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("gcloud:storage cp");
    expect(calls).not.toContain("build");
  });
});

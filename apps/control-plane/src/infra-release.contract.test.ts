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
  mkdirSync(bin);
  mkdirSync(scratch);
  copyFileSync(resolve("infra/release.sh"), join(infra, "release.sh"));
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
  executable(
    join(bin, "gcloud"),
    `echo "gcloud:$*" >> "$CALL_LOG"
if [ "$1" = auth ]; then echo token; exit 0; fi
if [ "$1 $2" = "storage cp" ]; then exit "\${MOCK_LOCK_STATUS:-0}"; fi
if [ "$1 $2 $3" = "storage objects describe" ]; then echo 42; exit 0; fi
if [ "$1 $2" = "storage rm" ]; then exit 0; fi
cat <<'JSON'
{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"PI_ORB_SCRIPT_GENERATION","value":"200"}]}]}}}}
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
  *" apply "*)
    if [ "\${MOCK_APPLY_SIGNAL:-}" = TERM ]; then kill -TERM "$PPID"; sleep 0.1; exit 143; fi
    exit "\${MOCK_APPLY_STATUS:-0}"
    ;;
esac
`,
  );
  executable(
    join(infra, "build-push.sh"),
    `echo build >> "$CALL_LOG"
cat <<'VARS'
control_plane_image = "registry/control@sha256:abc"
runtime_image       = "registry/runtime@sha256:def"
deploy_generation   = 100
VARS
`,
  );
  executable(join(infra, "deploy.sh"), 'echo "deploy:$*" >> "$CALL_LOG"\n');
  executable(join(infra, "smoke.sh"), 'echo smoke >> "$CALL_LOG"\n');

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
  "run services describe pi-orb") echo serving-revision ;;
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
    expect(readFileSync(log, "utf8")).toContain("run revisions delete old-revision");
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
    expect(result.stdout).toContain("deploy generation:    201");
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(
      /gcloud:storage cp[\s\S]*build[\s\S]*tofu:.* init[\s\S]*tofu:.* plan[\s\S]*tofu:.* apply[\s\S]*deploy:[\s\S]*smoke[\s\S]*gcloud:storage rm/,
    );
    expect(calls).toContain("plan-mode:600");
    expect(calls).not.toContain("--iap-only");
    const planPath = calls.match(/tofu:.* plan .* -out=([^ ]+)/)?.[1];
    expect(planPath).toBeDefined();
    expect(calls).toContain(`tofu:-chdir=${join(root, "infra")} apply -input=false ${planPath}`);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
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

"""Export only validated release evidence, never the runner's diagnostic directory."""
import re
import sys
from pathlib import Path
from infra.release_state import Result, fail, load, save, validate_record


def report(record, commit, outcome):
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or outcome not in ("success", "failure", "cancelled", "skipped"):
        return fail("invalid", "invalid workflow result context")
    lines = ["## Release", f"Runner commit: `{commit}`", f"Transaction step: **{outcome}**"]
    if record is None:
        if outcome == "success":
            return fail("invalid", "successful transaction has no release evidence")
        lines.append("No release record was created. No validated deployment is established by this run.")
        return Result("\n\n".join(lines) + "\n")
    if not validate_record(record) or record["runnerCommit"] != commit:
        return fail("invalid", "refusing to export an invalid or foreign release record")
    if outcome == "success" and (record["outcome"] != "validated" or record["phase"] != "complete" or record["exitCode"] != 0 or record["finishedAt"] is None):
        return fail("invalid", "successful transaction has no completed validation evidence")
    lines.extend([
        f"Release: `{record['releaseId']}`",
        f"Source commit: `{record['commit']}`",
        f"Recorded outcome: **{record['outcome']}**; phase: `{record['phase']}`",
        f"Durable evidence: `gs://pi-orb-tfstate-{record['project']}/static-plane/releases/{record['releaseId']}.json`",
    ])
    if record["validatesRelease"]:
        lines.append(f"Validation of `{record['validatesRelease']}`; the original record is unchanged.")
    if record["migrationJob"]:
        lines.append(f"Recorded migration job: `{record['migrationJob']}`. On uncertain execution, inspect it and the retained release lock before any new apply.")
    retained = [item for item in record["fixtures"] if item["outcome"] in ("retained", "cleanup-failed")]
    if retained:
        lines.append("Retained fixtures may incur costs:\n" + "\n".join(
            f"- {item['kind']} `{item['id']}`: {item['outcome']}" for item in retained))
    if outcome != "success":
        lines.append("This workflow did not complete successfully, regardless of individual passed gates. Do not blindly retry or remove locks.")
    return Result("\n\n".join(lines) + "\n")


def export(source, destination, commit, outcome, summary_path):
    try:
        exists = Path(source).exists()
    except OSError:
        return fail("io", "cannot inspect release result")
    loaded = load(source) if exists else Result(None)
    if loaded.error:
        return loaded
    rendered = report(loaded.value, commit, outcome)
    if rendered.error:
        return rendered
    try:
        with Path(summary_path).open("a", encoding="utf8") as summary:
            summary.write(rendered.value)
        if loaded.value is not None:
            Path(destination).mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        return fail("io", "cannot write workflow summary")
    return save(Path(destination) / "release.json", loaded.value) if loaded.value is not None else Result(None)


if __name__ == "__main__":
    if len(sys.argv) != 6:
        print("release report: invalid arguments", file=sys.stderr)
        sys.exit(2)
    result = export(*sys.argv[1:])
    if result.error:
        print("release report: evidence rejected or unavailable; inspect the failed step, not raw diagnostic artifacts", file=sys.stderr)
        sys.exit(1)

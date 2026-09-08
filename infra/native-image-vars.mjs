import { readFileSync } from "node:fs";

// CLI adapter: malformed external manifests fail before any release publication.
try {
  const [path, commit, project] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.status !== "accepted" ||
    manifest.validation !== true ||
    manifest.sourceDirty !== false ||
    manifest.sourceCommit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    manifest.project !== project ||
    typeof manifest.imageResource !== "string" ||
    !manifest.imageResource.startsWith(`projects/${project}/global/images/pi-orb-`) ||
    !/^projects\/[a-z0-9-]+\/global\/images\/[a-z][a-z0-9-]*$/.test(manifest.imageResource) ||
    typeof manifest.imageId !== "string" ||
    !/^[1-9][0-9]*$/.test(manifest.imageId)
  ) {
    process.stderr.write("image manifest: rejected acceptance, provenance, or image identity\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `native_image_resource = ${JSON.stringify(manifest.imageResource)}\nnative_image_id = ${JSON.stringify(manifest.imageId)}\n`,
    );
  }
} catch {
  process.stderr.write("image manifest: could not read valid JSON\n");
  process.exitCode = 1;
}

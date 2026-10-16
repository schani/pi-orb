import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { durationWeights } from "./duration-weights.ts";

/** Longest processing time first; input and ties never depend on Vitest's result cache. */
export function balanceFiles(
  files: readonly string[],
  count: number,
  weights: Readonly<Record<string, number>>,
) {
  const fallback = Math.max(1, ...Object.values(weights));
  const weight = (file: string) => weights[file] ?? fallback;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], estimatedMs: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || compare(a, b))) {
    const shard = shards.reduce((best, candidate) =>
      candidate.estimatedMs < best.estimatedMs ||
      (candidate.estimatedMs === best.estimatedMs && candidate.files.length < best.files.length)
        ? candidate
        : best,
    );
    shard.files.push(file);
    shard.estimatedMs += weight(file);
  }
  return shards;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class DurationBalancedSequencer extends BaseSequencer {
  private axis(spec: TestSpecification) {
    return spec.project.name === "frontend"
      ? "frontend"
      : process.env["PI_ORB_E2E_BACKEND"] === "process"
        ? "process"
        : "docker";
  }

  private path(spec: TestSpecification) {
    return relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
  }

  private weight(spec: TestSpecification) {
    const weights: Readonly<Record<string, number>> = durationWeights[this.axis(spec)].files;
    return weights[this.path(spec)] ?? Math.max(...Object.values(weights));
  }

  override async shard(specs: TestSpecification[]) {
    const shard = this.ctx.config.shard;
    if (shard === undefined) return this.sort(specs);
    const { index, count } = shard;
    const byKey = new Map(specs.map((spec) => [`${spec.project.name}:${this.path(spec)}`, spec]));
    const weights = Object.fromEntries([...byKey].map(([key, spec]) => [key, this.weight(spec)]));
    const plan = balanceFiles([...byKey.keys()], count, weights);
    console.info(
      "E2E duration shard plan",
      JSON.stringify({
        index,
        count,
        sources: Object.fromEntries(
          [...new Set(specs.map((spec) => this.axis(spec)))]
            .sort()
            .map((axis) => [axis, durationWeights[axis].source]),
        ),
        unmeasured: specs
          .filter((spec) => !(this.path(spec) in durationWeights[this.axis(spec)].files))
          .map((spec) => `${spec.project.name}:${this.path(spec)}`)
          .sort(),
        shards: plan,
      }),
    );
    const selected = new Set(plan[index - 1]?.files);
    return specs
      .filter((spec) => selected.has(`${spec.project.name}:${this.path(spec)}`))
      .sort((a, b) => compare(this.path(a), this.path(b)));
  }

  override async sort(specs: TestSpecification[]) {
    return [...specs].sort(
      (a, b) =>
        a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder ||
        compare(a.project.name, b.project.name) ||
        this.weight(b) - this.weight(a) ||
        compare(this.path(a), this.path(b)),
    );
  }
}

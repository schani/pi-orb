import type { EntropySource } from "determined";

/**
 * Reproducible entropy: a seed alone replays a generated fixture exactly,
 * so a failing schedule is identified by its seed rather than a trace file.
 */
export class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export class E2eReconcileCheckpoints {
  private readonly requests = new Map<string, Map<string, number>>();

  request(orbId: string, requestId: string, generation: number): void {
    const orb = this.requests.get(orbId) ?? new Map<string, number>();
    orb.set(requestId, generation);
    this.requests.set(orbId, orb);
  }

  complete(orbId: string, generation: number): string[] {
    const orb = this.requests.get(orbId);
    if (orb === undefined) return [];
    const completed: string[] = [];
    for (const [requestId, requestedGeneration] of orb) {
      if (generation < requestedGeneration) continue;
      orb.delete(requestId);
      completed.push(requestId);
    }
    if (orb.size === 0) this.requests.delete(orbId);
    return completed;
  }
}

import type { ActiveSubagent } from "@pi-orb/protocol";

/** Native result is only a root edge. Idle requires supervised process exit and committed history. */
export class ClaudeActivity {
  private operation: string | null = null;
  private rootDone = false;
  private draining = false;
  private cancelled = false;
  private readonly hooks = new Set<string>();
  private readonly admittedChildren = new Map<string, string>();
  private readonly handoffs = new Map<string, string>();
  private readonly tasks = new Map<string, { description: string; ambient: boolean }>();
  private readonly edgeTasks = new Map<string, { description: string; ambient: boolean }>();
  get operationId(): string | null {
    return this.operation;
  }
  get busy(): boolean {
    return this.operation !== null;
  }
  get hookCount(): number {
    return this.hooks.size;
  }
  get canDrain(): boolean {
    return (
      this.busy &&
      this.rootDone &&
      !this.draining &&
      this.hooks.size === 0 &&
      this.admittedChildren.size === 0 &&
      this.handoffs.size === 0 &&
      ![...this.tasks.values(), ...this.edgeTasks.values()].some((task) => !task.ambient)
    );
  }
  get children(): ActiveSubagent[] {
    const children = new Map(
      [...this.tasks, ...this.edgeTasks]
        .filter(([, task]) => !task.ambient)
        .map(([id, task]) => [id, task.description]),
    );
    for (const [id, description] of this.admittedChildren) children.set(id, description);
    for (const [id, description] of this.handoffs) children.set(id, description);
    return [...children].map(([id, description]) => ({
      id,
      description,
      phase: this.cancelled || this.draining || this.handoffs.has(id) ? "finishing" : "running",
    }));
  }
  childAdmitted(id: string, description: string): void {
    this.admittedChildren.set(id, description);
  }
  childTerminal(id: string): void {
    this.admittedChildren.delete(id);
  }
  claim(id: string): boolean {
    if (this.busy) return false;
    this.operation = id;
    this.rootDone = false;
    this.draining = false;
    this.cancelled = false;
    return true;
  }
  rootFinished(): void {
    this.rootDone = true;
    this.handoffs.clear();
  }
  hasTask(id: string): boolean {
    return (
      this.admittedChildren.has(id) ||
      this.edgeTasks.get(id)?.ambient === false ||
      this.tasks.get(id)?.ambient === false
    );
  }
  taskHandoff(id: string, description: string): void {
    this.handoffs.set(id, description);
    this.rootDone = false;
  }
  rootStarted(): void {
    this.rootDone = false;
  }
  hookStart(id: string): void {
    this.hooks.add(id);
  }
  hookEnd(id: string): void {
    this.hooks.delete(id);
  }
  taskStart(id: string, description: string, ambient: boolean): void {
    this.edgeTasks.set(id, { description, ambient });
  }
  taskEnd(id: string): void {
    this.edgeTasks.delete(id);
  }
  replaceTasks(tasks: readonly { id: string; description: string; ambient?: boolean }[]): void {
    this.tasks.clear();
    for (const task of tasks)
      this.tasks.set(task.id, { description: task.description, ambient: task.ambient === true });
  }
  cancel(): void {
    this.cancelled = true;
  }
  beginDrain(): void {
    this.draining = true;
  }
  processExited(historyCommitted: boolean): void {
    if (!historyCommitted || this.hooks.size > 0) return;
    this.operation = null;
    this.tasks.clear();
    this.edgeTasks.clear();
    this.admittedChildren.clear();
    this.handoffs.clear();
    this.draining = false;
  }
}

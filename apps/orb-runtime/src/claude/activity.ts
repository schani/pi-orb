import type { ActiveSubagent } from "@pi-orb/protocol";

type TaskKind = "agent" | "shell";
type TaskActivity = { description: string; ambient: boolean; kind: TaskKind | undefined };

function taskKind(taskType: string | undefined): TaskKind | undefined {
  if (taskType === "local_agent") return "agent";
  if (taskType === "local_bash") return "shell";
  return undefined;
}

/** Native result is only a root edge. Idle requires supervised process exit and committed history. */
export class ClaudeActivity {
  private operation: string | null = null;
  private rootDone = false;
  private draining = false;
  private cancelled = false;
  private readonly hooks = new Set<string>();
  private readonly admittedChildren = new Map<string, string>();
  private readonly handoffs = new Map<
    string,
    { description: string; requested: boolean; kind: TaskKind | undefined }
  >();
  private readonly tasks = new Map<string, TaskActivity>();
  private readonly edgeTasks = new Map<string, TaskActivity>();
  get operationId(): string | null {
    return this.operation;
  }
  get busy(): boolean {
    return this.operation !== null;
  }
  get hookCount(): number {
    return this.hooks.size;
  }
  get drainHolds(): string[] {
    const holds: string[] = [];
    if (!this.rootDone) holds.push("root");
    if (this.hooks.size > 0) holds.push("hooks");
    if (this.admittedChildren.size > 0) holds.push("children");
    if (this.handoffs.size > 0) holds.push("handoffs");
    if ([...this.tasks.values()].some((task) => !task.ambient)) holds.push("inventory");
    if ([...this.edgeTasks.values()].some((task) => !task.ambient)) holds.push("tasks");
    return holds;
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
        .filter(([id, task]) => !task.ambient && this.kind(id) !== undefined)
        .map(([id, task]) => [id, task.description]),
    );
    for (const [id, description] of this.admittedChildren) children.set(id, description);
    for (const [id, handoff] of this.handoffs)
      if (handoff.kind !== undefined) children.set(id, handoff.description);
    return [...children].map(([id, description]) => ({
      id,
      description,
      ...(this.kind(id) === "shell" ? { kind: "shell" as const } : {}),
      phase: this.cancelled || this.draining || this.handoffs.has(id) ? "finishing" : "running",
    }));
  }
  private kind(id: string): TaskKind | undefined {
    if (this.admittedChildren.has(id)) return "agent";
    return this.handoffs.get(id)?.kind ?? this.edgeTasks.get(id)?.kind ?? this.tasks.get(id)?.kind;
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
  rootFinished(inferenceCompleted = false): string[] {
    const completed: string[] = [];
    if (!this.draining && inferenceCompleted)
      for (const [id, handoff] of this.handoffs)
        if (handoff.requested) {
          this.handoffs.delete(id);
          completed.push(id);
        }
    this.rootDone = this.handoffs.size === 0;
    return completed;
  }
  rootRequested(): void {
    this.rootStarted();
    for (const handoff of this.handoffs.values()) handoff.requested = true;
  }
  get awaitingHandoffInference(): string[] {
    return [...this.handoffs].filter(([, handoff]) => !handoff.requested).map(([id]) => id);
  }
  hasTask(id: string): boolean {
    return (
      this.admittedChildren.has(id) ||
      this.edgeTasks.get(id)?.ambient === false ||
      this.tasks.get(id)?.ambient === false
    );
  }
  hasEdgeTask(id: string): boolean {
    return this.edgeTasks.get(id)?.ambient === false;
  }
  handoffInterrupted(id: string): void {
    this.handoffs.delete(id);
  }
  taskHandoff(id: string, description: string): void {
    this.handoffs.set(id, { description, requested: false, kind: this.kind(id) });
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
  taskStart(id: string, description: string, ambient: boolean, taskType?: string): void {
    this.edgeTasks.set(id, { description, ambient, kind: taskKind(taskType) ?? this.kind(id) });
  }
  taskEnd(id: string): void {
    this.edgeTasks.delete(id);
  }
  replaceTasks(
    tasks: readonly { id: string; description: string; ambient?: boolean; taskType?: string }[],
  ): void {
    this.tasks.clear();
    for (const task of tasks) {
      const kind = taskKind(task.taskType);
      this.tasks.set(task.id, {
        description: task.description,
        ambient: task.ambient === true,
        kind,
      });
      const edge = this.edgeTasks.get(task.id);
      if (edge !== undefined && kind !== undefined) edge.kind = kind;
    }
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

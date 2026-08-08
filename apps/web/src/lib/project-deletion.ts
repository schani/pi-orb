import type { ProjectDeletionProgress } from "@pi-orb/protocol";

export function projectDeletionConfirmation(projectName: string): string {
  return `Delete ${projectName} permanently? The project, every orb, all checkouts and files, compute resources, port access, and all conversation history will be lost.`;
}

export function projectDeletionProgressText(progress: ProjectDeletionProgress): string {
  return `deleting orbs: ${progress.remaining} of ${progress.total} remaining${
    progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ""
  }`;
}

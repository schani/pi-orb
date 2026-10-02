export declare function approvedWorkerTools(
  tools: readonly { name: string }[],
  authenticated: boolean,
): string[] | undefined;
export declare function writeWorkerProfile(cwd: string, names: readonly string[]): Promise<void>;

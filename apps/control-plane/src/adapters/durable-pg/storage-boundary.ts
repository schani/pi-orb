import { StorageRejected } from "@earendil-works/pi-durable";

/** Durable's third-party Storage interface signals rejection by throwing, not Result. */
export function rejectStorage(message: string, options?: { cause?: unknown }): never {
  // biome-ignore lint/plugin/no-throw: third-party Durable Storage contract requires promise rejection.
  throw new StorageRejected(message, options);
}

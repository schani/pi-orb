// Per execution, shared by the public worker bridge and host callbacks.
export const MAX_CALLBACK_CONCURRENCY = 8;
export const MAX_CALLBACK_CALLS = 256;
export const MAX_CALLBACK_ARGUMENT_BYTES = 8 * 1024 * 1024;
// Two 20 MiB images fit after base64 serialization.
export const MAX_CALLBACK_REPLY_BYTES = 64 * 1024 * 1024;
export const CALLBACK_LIMIT_MESSAGE =
  "Code-mode resource limit exceeded (8 outstanding callbacks / 256 calls / 8 MiB arguments / 64 MiB replies). Reduce batch size or callback output.";

import { constants } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { err, ok, ResultAsync } from "neverthrow";

export interface FileError {
  readonly status: 400 | 401 | 403 | 404 | 409 | 503;
  readonly message: string;
}
export const fileError = (status: FileError["status"], message: string): FileError => ({
  status,
  message,
});
const denied = () => fileError(403, "only ordinary files without symlinks are readable");
const ioError = (cause: unknown): FileError => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  return code === "ENOENT" || code === "ENOTDIR"
    ? fileError(404, "file does not exist")
    : ["EACCES", "EPERM", "ELOOP", "ENXIO"].includes(String(code))
      ? denied()
      : fileError(503, "file read failed");
};
const io = <T>(fn: () => Promise<T>) => ResultAsync.fromThrowable(fn, ioError)();

export async function openLiveFile(path: unknown, root?: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
    return err(fileError(400, "an absolute file path is required"));
  if (root !== undefined) {
    const unavailable = () => fileError(503, "file workspace is unavailable");
    if (!isAbsolute(root)) return err(unavailable());
    const canonical = await ResultAsync.fromThrowable(() => realpath(root), unavailable)();
    if (canonical.isErr()) return err(canonical.error);
    const within = relative(canonical.value, path);
    if (
      path !== normalize(path) ||
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    )
      return err(fileError(403, "file must use a canonical path inside this orb's workspace"));
  }
  if (/^\/(proc|sys|dev)(\/|$)/u.test(normalize(path))) return err(denied());
  // Check raw components so link/../file cannot hide a symlink.
  let prefix = "";
  let regular = false;
  for (const component of path.split("/").filter(Boolean)) {
    prefix += `/${component}`;
    const info = await io(() => lstat(prefix));
    if (info.isErr()) return err(info.error);
    if (info.value.isSymbolicLink()) return err(denied());
    regular = info.value.isFile();
  }
  if (!regular) return err(denied());
  const opened = await io(() =>
    open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  if (opened.isErr()) return err(opened.error);
  const handle = opened.value;
  const close = () => io(() => handle.close());
  const checked = await io(async () => {
    const stat = await handle.stat();
    const filesystem = await statfs(
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path,
    );
    // Proc/sys aliases can look like regular files; tmpfs remains readable.
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      [0x9fa0, 0x62656572].includes(filesystem.type)
    )
      return err(denied());
    // Fastify owns native stream errors, backpressure and disconnect cancellation.
    const stream = stat.size ? handle.createReadStream({ end: stat.size - 1 }) : Readable.from([]);
    return ok({ size: stat.size, stream, close });
  });
  const result = checked.andThen((file) => file);
  if (result.isErr()) await close();
  return result;
}

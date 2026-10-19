import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { transform } from "esbuild";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { extract } from "./extraction.ts";
import type { Definition, Draft, Entry, PromptError, RenderSnapshot, Source } from "./types.ts";
import { MAX_CONTENT_BYTES } from "./types.ts";

const ioError = (): PromptError => ({ code: "io", message: "Source file could not be accessed." });
const unsafe = (): PromptError => ({
  code: "unsafe_path",
  message: "Source path must be a regular file inside the checkout, without symlinks.",
});
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const io = <T>(operation: () => Promise<T>) => ResultAsync.fromThrowable(operation, ioError)();

export class SourceAdapter implements Source {
  private readonly root: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private checkedPath(path: string): ResultAsync<string, PromptError> {
    if (isAbsolute(path) || !path || path.split(/[\\/]/).some((part) => part === ".." || !part)) {
      return errAsync(unsafe());
    }
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) return errAsync(unsafe());
    return new ResultAsync(
      (async () => {
        const parts = rel.split("/");
        for (let i = 0; i < parts.length; i++) {
          const stat = await io(() => lstat(join(this.root, ...parts.slice(0, i + 1))));
          if (stat.isErr()) return err(stat.error);
          if (
            stat.value.isSymbolicLink() ||
            (i < parts.length - 1 ? !stat.value.isDirectory() : !stat.value.isFile())
          ) {
            return err(unsafe());
          }
        }
        return ok(full);
      })(),
    );
  }

  asset(path: string): ResultAsync<Buffer, PromptError> {
    return this.checkedPath(path).andThen((full) => io(() => readFile(full)));
  }

  private text(path: string): ResultAsync<string, PromptError> {
    return this.asset(path).andThen((buffer) =>
      buffer.byteLength > MAX_CONTENT_BYTES
        ? errAsync({ code: "too_large" as const, message: "Source exceeds the 1 MiB limit." })
        : okAsync(buffer.toString("utf8")),
    );
  }

  private entry(definition: Definition, text: string): Result<Entry, PromptError> {
    const prompt =
      definition.content !== undefined
        ? ok({ content: definition.content, variables: undefined })
        : extract(definition.path, text, definition.selector);
    return prompt.map((value) => ({
      id: definition.id,
      title: definition.title,
      category: definition.category,
      scope: definition.scope,
      editable: definition.editable,
      content: value.content,
      revision: digest(text),
      ...(definition.note !== undefined ? { note: definition.note } : {}),
      ...(value.variables?.length ? { variables: value.variables } : {}),
    }));
  }

  read(definition: Definition): ResultAsync<Entry, PromptError> {
    const content =
      definition.content !== undefined ? okAsync(definition.content) : this.text(definition.path);
    return content
      .andThen((text) => this.entry(definition, text))
      .andThen((entry) => {
        if (!definition.packagePath) return okAsync(entry);
        return this.asset(definition.packagePath).andThen((data) =>
          Result.fromThrowable(
            () => JSON.parse(data.toString("utf8")) as unknown,
            ioError,
          )().andThen((pkg) =>
            pkg !== null &&
            typeof pkg === "object" &&
            !Array.isArray(pkg) &&
            "name" in pkg &&
            "version" in pkg &&
            typeof pkg.name === "string" &&
            typeof pkg.version === "string"
              ? ok({ ...entry, scope: `${entry.scope} · ${pkg.name}@${pkg.version}` })
              : err(ioError()),
          ),
        );
      });
  }

  /** One read per allowlisted file; edits are AST/data replacements in memory only. */
  snapshot(
    catalog: readonly Definition[],
    drafts: readonly Draft[],
  ): ResultAsync<RenderSnapshot, PromptError> {
    const operation = this.pending.then(() => this.snapshotSerial(catalog, drafts));
    this.pending = operation.then(() => undefined);
    return new ResultAsync(operation);
  }

  private async snapshotSerial(
    catalog: readonly Definition[],
    drafts: readonly Draft[],
  ): Promise<Result<RenderSnapshot, PromptError>> {
    const files = new Map<string, string>();
    for (const definition of catalog) {
      if (definition.content !== undefined || files.has(definition.path)) continue;
      const content = await this.text(definition.path);
      if (content.isErr()) return err(content.error);
      files.set(definition.path, content.value);
    }
    for (const draft of drafts) {
      const definition = catalog.find(({ id }) => id === draft.id);
      if (!definition) return err({ code: "not_found", message: "Prompt doesn't exist." });
      if (!definition.editable || definition.content !== undefined)
        return err({ code: "read_only", message: "This prompt is read-only." });
      const original = files.get(definition.path);
      if (original === undefined) return err(ioError());
      if (digest(original) !== draft.revision)
        return err({ code: "conflict", message: "Prompt changed. Reload before rendering." });
    }
    for (const draft of drafts) {
      const definition = catalog.find(({ id }) => id === draft.id);
      if (!definition) return err({ code: "not_found", message: "Prompt doesn't exist." });
      const original = files.get(definition.path);
      if (original === undefined) return err(ioError());
      const patched = extract(definition.path, original, definition.selector).andThen((selected) =>
        selected.replace(draft.content),
      );
      if (patched.isErr()) return err(patched.error);
      files.set(definition.path, patched.value);
    }
    const entries: Entry[] = [];
    for (const definition of catalog) {
      const entry = this.entry(definition, definition.content ?? files.get(definition.path) ?? "");
      if (entry.isErr()) return err(entry.error);
      entries.push(entry.value);
    }
    for (const draft of drafts) {
      if (entries.find(({ id }) => id === draft.id)?.content !== draft.content)
        return err({ code: "invalid_request", message: "Draft could not be represented safely." });
    }
    return ok({
      entries,
      resources: [...files]
        .filter(([path]) => /^apps\/orb-runtime\/skills\/[^/]+\/SKILL\.md$/.test(path))
        .map(([path, content]) => ({
          path: path.replace("apps/orb-runtime/skills/", "/opt/pi-orb/skills/"),
          content,
        })),
    });
  }

  save(definition: Definition, content: string, revision: string): ResultAsync<Entry, PromptError> {
    const operation = this.pending.then(() => this.saveSerial(definition, content, revision));
    this.pending = operation.then(() => undefined);
    return new ResultAsync(operation);
  }

  private async saveSerial(
    definition: Definition,
    content: string,
    revision: string,
  ): Promise<Result<Entry, PromptError>> {
    if (!definition.editable || definition.content !== undefined)
      return err({ code: "read_only", message: "This prompt is read-only." });
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
      return err({ code: "too_large", message: "Content exceeds the 1 MiB limit." });
    const file = definition.path;
    const path = await this.checkedPath(file);
    if (path.isErr()) return err(path.error);
    const before = await this.text(file);
    if (before.isErr()) return err(before.error);
    if (digest(before.value) !== revision)
      return err({ code: "conflict", message: "Prompt changed. Reload before saving." });
    const selected = extract(file, before.value, definition.selector);
    if (selected.isErr()) return err(selected.error);
    const patched = selected.value.replace(content);
    if (patched.isErr()) return err(patched.error);
    const next = this.entry(definition, patched.value);
    if (next.isErr()) return err(next.error);
    if (next.value.content !== content)
      return err({
        code: "invalid_request",
        message: "Prompt edit could not be represented safely.",
      });
    if (patched.value === before.value) return next;
    if (Buffer.byteLength(patched.value, "utf8") > MAX_CONTENT_BYTES)
      return err({ code: "too_large", message: "Source exceeds the 1 MiB limit." });
    const extension = file.split(".").at(-1);
    if (extension === "ts" || extension === "tsx" || extension === "js" || extension === "mjs") {
      const syntax = await ResultAsync.fromThrowable(
        () =>
          transform(patched.value, {
            loader: extension === "mjs" ? "js" : extension,
            sourcefile: file,
            logLevel: "silent",
          }),
        (): PromptError => ({
          code: "syntax",
          message: "Invalid source syntax. File was not changed.",
        }),
      )();
      if (syntax.isErr()) return err(syntax.error);
    }
    const stat = await io(() => lstat(path.value));
    if (stat.isErr()) return err(stat.error);
    const temporary = join(
      dirname(path.value),
      `.prompt-review-${randomBytes(12).toString("hex")}.tmp`,
    );
    const written = await io(() =>
      writeFile(temporary, patched.value, {
        encoding: "utf8",
        flag: "wx",
        mode: stat.value.mode & 0o777,
      }),
    );
    if (written.isErr()) {
      await io(() => unlink(temporary));
      return err(written.error);
    }
    const checked = await this.checkedPath(file);
    const current = checked.isOk() ? await this.text(file) : checked;
    let outcome: Result<Entry, PromptError>;
    if (current.isErr()) outcome = err(current.error);
    else if (digest(current.value) !== revision)
      outcome = err({ code: "conflict", message: "Prompt changed. Reload before saving." });
    else {
      const replaced = await io(() => rename(temporary, path.value));
      outcome = replaced.isErr() ? err(replaced.error) : next;
    }
    if (outcome.isErr()) await io(() => unlink(temporary));
    return outcome;
  }
}

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { err, ok, Result, type Result as ResultType } from "neverthrow";

interface FixtureError {
  code: "claude_native_fixture_failed";
  operation: "copy" | "resolve" | "cleanup";
  path: string;
  cleanupFailed?: boolean;
}
interface Fixture {
  directory: string;
  root: string;
  helpers: string;
  packages: string[];
  dispose(): ResultType<void, FixtureError>;
}
interface Package {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const helpers = [
  "claude-acceptance.sh",
  "claude-worker.mjs",
  "claude-workload.mjs",
  "claude-receipt-edge.mjs",
];
const runtimePackages = [
  "@anthropic-ai/claude-agent-sdk",
  "@earendil-works/pi-coding-agent",
  "@modelcontextprotocol/sdk",
  "@pi-orb/protocol",
  "determined",
  "neverthrow",
  "typebox",
];

function dispose(directory: string): ResultType<void, FixtureError> {
  return Result.fromThrowable(
    () => rmSync(directory, { recursive: true, force: true }),
    (): FixtureError => ({
      code: "claude_native_fixture_failed",
      operation: "cleanup",
      path: directory,
    }),
  )();
}

/** Filesystem adapter for synthetic fixtures; never link a guest back into its caller's checkout. */
export function stageClaudeNativeFixture(
  checkoutPath: string,
  runtime = true,
): ResultType<Fixture, FixtureError> {
  let directory: string | undefined;
  let operation: FixtureError["operation"] = "copy";
  let path = "infra/native-vm/claude-acceptance.sh";
  const outcome = Result.fromThrowable(
    (): ResultType<Fixture, FixtureError> => {
      const checkout = resolve(checkoutPath);
      // TMPDIR may itself be inside a private checkout or HOME.
      const owned = mkdtempSync("/tmp/pi-orb-claude-native-fixture-");
      directory = owned;
      const root = join(owned, "candidate");
      const validator = join(owned, "validator");
      mkdirSync(root);
      mkdirSync(validator);
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      for (const file of helpers) {
        path = `infra/native-vm/${file}`;
        copyFileSync(join(checkout, path), join(validator, file));
        chmodSync(join(validator, file), lstatSync(join(checkout, path)).mode & 0o777);
      }
      const copy = (source: string, destination: string) => {
        operation = "copy";
        path = relative(checkout, source);
        cpSync(source, destination, {
          recursive: true,
          dereference: true,
          filter: (entry) => {
            const parts = relative(source, entry).split(sep);
            return (
              !parts.some((part) => part === "node_modules" || part === "testkit") &&
              !/\.test\.[^.]+$/.test(entry)
            );
          },
        });
      };
      const findPackage = (name: string, importer: string): string | null => {
        let current = importer;
        while (current === checkout || !relative(checkout, current).startsWith("..")) {
          const candidate = join(current, "node_modules", name);
          if (existsSync(join(candidate, "package.json"))) return candidate;
          if (current === checkout) break;
          current = dirname(current);
        }
        return null;
      };
      const copied = new Set<string>();
      const packages = new Set<string>();
      const copyPackage = (
        name: string,
        importer: string,
        optional = false,
      ): ResultType<void, FixtureError> => {
        operation = "resolve";
        path = name;
        const source = findPackage(name, importer);
        if (source === null)
          return optional
            ? ok(undefined)
            : err({ code: "claude_native_fixture_failed", operation, path });
        const alias = join(root, relative(checkout, source));
        // Node strips workspace TypeScript only outside node_modules.
        const destination = name === "@pi-orb/protocol" ? join(root, "packages/protocol") : alias;
        if (copied.has(destination)) return ok(undefined);
        copied.add(destination);
        packages.add(name);
        copy(source, destination);
        if (destination !== alias) {
          mkdirSync(dirname(alias), { recursive: true });
          symlinkSync(relative(dirname(alias), destination), alias, "dir");
        }
        const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as Package;
        const dependencies = {
          ...metadata.peerDependencies,
          ...metadata.dependencies,
          ...metadata.optionalDependencies,
        };
        for (const dependency of Object.keys(dependencies)) {
          const result = copyPackage(
            dependency,
            source,
            dependency in (metadata.optionalDependencies ?? {}) ||
              metadata.peerDependenciesMeta?.[dependency]?.optional === true,
          );
          if (result.isErr()) return result;
        }
        return ok(undefined);
      };
      if (runtime) {
        copy(join(checkout, "apps/orb-runtime/src"), join(root, "apps/orb-runtime/src"));
        copy(
          join(checkout, "apps/orb-runtime/package.json"),
          join(root, "apps/orb-runtime/package.json"),
        );
      }
      for (const name of runtime ? runtimePackages : ["neverthrow"]) {
        const result = copyPackage(name, checkout);
        if (result.isErr()) return err(result.error);
      }
      const readable = (entry: string) => {
        operation = "copy";
        path = relative(owned, entry);
        const metadata = lstatSync(entry);
        if (metadata.isSymbolicLink()) return;
        chmodSync(entry, metadata.isDirectory() || (metadata.mode & 0o111) !== 0 ? 0o755 : 0o644);
        if (metadata.isDirectory())
          for (const name of readdirSync(entry)) readable(join(entry, name));
      };
      readable(owned);
      return ok({
        directory: owned,
        root,
        helpers: validator,
        packages: [...packages].sort(),
        dispose: () => dispose(owned),
      });
    },
    (): FixtureError => ({ code: "claude_native_fixture_failed", operation, path }),
  )().andThen((result) => result);
  if (outcome.isErr() && directory !== undefined) {
    const cleanup = dispose(directory);
    if (cleanup.isErr()) return err({ ...outcome.error, cleanupFailed: true });
  }
  return outcome;
}

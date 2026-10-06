import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, ok, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { durableError } from "../durable/manager.ts";
import { LazyExecutionEnv } from "./lazy-env.ts";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("lazy execution", () => {
  it("does not retain unbound generation facades and closes joined invocations once", async () => {
    let acquired = 0;
    let closed = 0;
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    remote.exists = async () => ({ ok: true, value: true });
    remote.cleanup = async () => {
      closed++;
    };
    const root = new LazyExecutionEnv({
      cwd: "/repo",
      acquire: () => {
        acquired++;
        return ResultAsync.fromSafePromise(Promise.resolve(remote));
      },
    });
    let unbound = root.invocation();
    for (let index = 0; index < 100; index++) unbound = root.invocation();
    expect(root.retainedInvocations()).toBe(0);
    const bound = root.invocation();
    await bound.exists("file", BACKGROUND_CONTEXT);
    expect(root.retainedInvocations()).toBe(1);
    const a = root.cleanup(BACKGROUND_CONTEXT);
    const b = root.cleanup(BACKGROUND_CONTEXT);
    expect(a).toBe(b);
    await a;
    expect(closed).toBe(1);
    expect(root.retainedInvocations()).toBe(0);
    expect((await unbound.exists("late", BACKGROUND_CONTEXT)).ok).toBe(false);
    expect(acquired).toBe(1);
  });

  it("does not acquire until an operation and rechecks cancellation after readiness", async () => {
    const released = barrier<void>();
    const entered = barrier<void>();
    let effects = 0;
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    remote.exists = async () => {
      effects++;
      return { ok: true, value: true };
    };
    const env = new LazyExecutionEnv({
      cwd: "/workspace/repo",
      acquire: () => {
        entered.resolve();
        return ResultAsync.fromSafePromise(released.promise).map(() => remote);
      },
    });
    expect(effects).toBe(0);
    const cancel = new AbortController();
    const result = env.exists("file", withAbortSignal(cancel.signal, BACKGROUND_CONTEXT));
    await entered.promise;
    cancel.abort();
    released.resolve();
    expect((await result).ok).toBe(false);
    expect(effects).toBe(0);
  });

  it("rejects a stale model decision with a bounded private-content-free reason", async () => {
    let effects = 0;
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    remote.exists = async () => {
      effects++;
      return { ok: true, value: true };
    };
    let adopted = false;
    const env = new LazyExecutionEnv({
      cwd: "/workspace/repo",
      acquire: () =>
        ResultAsync.fromSafePromise(Promise.resolve()).map(() => {
          adopted = true;
          return remote;
        }),
      admit: () =>
        adopted
          ? err(durableError("Host instructions adopted; re-evaluate the operation."))
          : ok(undefined),
    });
    const result = await env.exists("file", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("Host instructions adopted; re-evaluate the operation.");
    expect(effects).toBe(0);
  });

  it("forwards cleanup cancellation into an already dispatched RPC", async () => {
    const entered = barrier<void>();
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    let aborted = false;
    remote.exists = async (_path, ctx) => {
      entered.resolve();
      await new Promise<void>((done) =>
        ctx.abortSignal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            done();
          },
          { once: true },
        ),
      );
      return { ok: true, value: false };
    };
    const env = new LazyExecutionEnv({
      cwd: "/repo",
      acquire: () => ResultAsync.fromSafePromise(Promise.resolve(remote)),
    });
    const pending = env.exists("file", BACKGROUND_CONTEXT);
    await entered.promise;
    await env.cleanup(BACKGROUND_CONTEXT);
    await pending;
    expect(aborted).toBe(true);
  });

  it("pins the entire invocation and refuses effects after its authority is revoked", async () => {
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    let acquisitions = 0;
    let effects = 0;
    let revoked = false;
    remote.exists = async () => {
      effects++;
      return { ok: true, value: true };
    };
    const env = new LazyExecutionEnv({
      cwd: "/repo",
      acquire: () => {
        acquisitions++;
        return ResultAsync.fromSafePromise(Promise.resolve(remote));
      },
      validate: () =>
        revoked
          ? ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
              err(durableError("execution admission revoked")),
            )
          : ResultAsync.fromSafePromise(Promise.resolve()),
    });
    expect((await env.exists("first", BACKGROUND_CONTEXT)).ok).toBe(true);
    revoked = true;
    expect((await env.exists("second", BACKGROUND_CONTEXT)).ok).toBe(false);
    expect(acquisitions).toBe(1);
    expect(effects).toBe(1);
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("close cancels waiting operations without any VM effect", async () => {
    const entered = barrier<void>();
    const env = new LazyExecutionEnv({
      cwd: "/workspace/repo",
      acquire: (ctx) => {
        entered.resolve();
        return ResultAsync.fromSafePromise(
          new Promise<void>((done) =>
            ctx.abortSignal?.addEventListener("abort", () => done(), { once: true }),
          ),
        ).andThen(() => err(durableError("cancelled")));
      },
    });
    const waiting = env.exec("effect", undefined, BACKGROUND_CONTEXT);
    await entered.promise;
    await env.cleanup(BACKGROUND_CONTEXT);
    expect((await waiting).ok).toBe(false);
  });
});

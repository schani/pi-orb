import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import { settleBootPrerequisites } from "./boot-prerequisites.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("concurrent boot prerequisites", () => {
  it("waits for checkout after Rust fails", async () => {
    const rust = deferred<Result<string, string>>();
    const checkout = deferred<Result<string, string>>();
    let settled = false;
    const started: string[] = [];
    const result = settleBootPrerequisites(
      () => {
        started.push("rust");
        return rust.promise;
      },
      () => {
        started.push("checkout");
        return checkout.promise;
      },
    ).then((value) => {
      settled = true;
      return value;
    });

    expect(started).toEqual(["rust", "checkout"]);
    rust.resolve(err("rust failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    checkout.resolve(ok("commit"));

    expect((await result)._unsafeUnwrapErr()).toBe("rust failed");
  });

  it("chooses Rust deterministically when both fail", async () => {
    const result = await settleBootPrerequisites(
      () => Promise.resolve(err("rust failed")),
      () => Promise.resolve(err("clone failed")),
    );
    expect(result._unsafeUnwrapErr()).toBe("rust failed");
  });
});

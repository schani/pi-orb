import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { readExecutionIdentity } from "./execution-identity.ts";

const stat = (start: string) => `1 (node (runtime)) S ${Array(18).fill("0").join(" ")} ${start} 0`;
it("container identity changes with PID 1 lifetime or kernel boot, not runtime PID", () => {
  const read = (boot: string, start: string) => (path: string) =>
    ok(path.endsWith("boot_id") ? boot : stat(start));
  const env = { PI_ORB_CONTAINER: "1" };
  expect(readExecutionIdentity(env, read("kernel-a", "100"))._unsafeUnwrap()).toBe("kernel-a:100");
  expect(readExecutionIdentity(env, read("kernel-a", "200"))._unsafeUnwrap()).toBe("kernel-a:200");
  expect(readExecutionIdentity(env, read("kernel-b", "100"))._unsafeUnwrap()).toBe("kernel-b:100");
});
it("process hosts never infer process loss from the containing machine's procfs", () => {
  expect(
    readExecutionIdentity({ PI_ORB_CONTAINER: "0" }, () =>
      err({ type: "execution_identity_error", code: "read_failed", message: "must not read" }),
    )._unsafeUnwrap(),
  ).toBeNull();
});
it("unknown hosts are conservative and broken configured identities are typed errors", () => {
  expect(readExecutionIdentity({})._unsafeUnwrap()).toBeNull();
  expect(
    readExecutionIdentity({ PI_ORB_CONTAINER: "1" }, () =>
      err({ type: "execution_identity_error", code: "read_failed", message: "denied" }),
    ).isErr(),
  ).toBe(true);
  expect(readExecutionIdentity({ PI_ORB_CONTAINER: "1" }, () => ok("bad stat")).isErr()).toBe(true);
});

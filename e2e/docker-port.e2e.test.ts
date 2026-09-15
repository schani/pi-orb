import { describe, expect, it } from "vitest";
import { parseDockerLoopbackPort } from "./docker-port.ts";

describe("Docker-assigned loopback port", () => {
  it("reads the single loopback mapping Docker owns", () => {
    expect(parseDockerLoopbackPort("127.0.0.1:32789\n")._unsafeUnwrap()).toBe(32789);
    expect(parseDockerLoopbackPort("127.0.0.1:65535")._unsafeUnwrap()).toBe(65535);
  });

  it.each([
    "",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "0.0.0.0:32789",
    "[::]:32789",
    "127.0.0.1:32789\n127.0.0.1:32790",
    "127.0.0.1:not-a-port",
    "127.0.0.1:32789 trailing",
  ])("rejects an invalid or non-loopback mapping: %s", (output) => {
    expect(parseDockerLoopbackPort(output).isErr()).toBe(true);
  });
});

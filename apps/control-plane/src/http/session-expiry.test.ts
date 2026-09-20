import { describe, expect, it } from "vitest";
import { watchSessionExpiry } from "./session-expiry.ts";

describe("socket session expiry", () => {
  it("expires once at the deadline and stops admitting before a delayed timer runs", () => {
    let now = 10;
    let expired = 0;
    let cancelled = 0;
    let fire: () => void = () => undefined;
    const session = watchSessionExpiry(
      20,
      () => now,
      () => expired++,
      (delay, callback) => {
        expect(delay).toBe(10);
        fire = callback;
        return () => cancelled++;
      },
    );
    expect(session.admit()).toBe(true);
    now = 20;
    expect(session.admit()).toBe(false);
    expect(expired).toBe(1);
    fire();
    session.stop();
    expect(expired).toBe(1);
    expect(cancelled).toBe(1);
  });

  it("an already expired session cannot route upstream", () => {
    let expired = 0;
    const session = watchSessionExpiry(
      20,
      () => 20,
      () => expired++,
      () => {
        throw new Error("expired sessions must not schedule");
      },
    );
    expect(session.admit()).toBe(false);
    expect(expired).toBe(1);
  });

  it("stopping a socket cancels its owned deadline and fences delayed callbacks", () => {
    let fire: () => void = () => undefined;
    let expired = 0;
    let cancelled = 0;
    const session = watchSessionExpiry(
      20,
      () => 10,
      () => expired++,
      (_delay, callback) => {
        fire = callback;
        return () => cancelled++;
      },
    );
    session.stop();
    session.stop();
    fire();
    expect(session.admit()).toBe(false);
    expect(expired).toBe(0);
    expect(cancelled).toBe(1);
  });

  it("local connections have no session deadline", () => {
    const session = watchSessionExpiry(
      undefined,
      () => 100,
      () => {
        throw new Error("local connection has no expiry");
      },
      () => {
        throw new Error("local connection must not schedule");
      },
    );
    expect(session.admit()).toBe(true);
    session.stop();
    expect(session.admit()).toBe(false);
  });
});

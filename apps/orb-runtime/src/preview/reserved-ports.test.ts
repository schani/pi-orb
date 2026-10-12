import { expect, it } from "vitest";
import { runtimeReservedPorts } from "./reserved-ports.ts";

it("blocks the actual listener and configured platform endpoints rather than fixed guessed ports", () => {
  expect(
    runtimeReservedPorts(4567, {
      PI_ORB_RUNTIME_PORT: "8081",
      PORT: "3000",
      PI_ORB_CONTROL_PLANE_URL: "http://127.0.0.1:4444",
    }),
  ).toEqual([8080, 4567, 8081, 3000, 4444]);
  expect(
    runtimeReservedPorts(0, { PI_ORB_CONTROL_PLANE_URL: "https://platform.example" }),
  ).not.toContain(443);
  expect(
    runtimeReservedPorts(443, { PI_ORB_CONTROL_PLANE_URL: "https://platform.example" }),
  ).toContain(443);
  expect(
    runtimeReservedPorts(4567, { PI_ORB_CONTROL_PLANE_URL: "http://platform.example" }),
  ).not.toContain(80);
  expect(runtimeReservedPorts(4567, { PORT: "NaN", PI_ORB_CONTROL_PLANE_URL: "invalid" })).toEqual([
    8080, 4567,
  ]);
});

import { expect, it } from "vitest";
import { previewRequestHeaders, previewResponseHeaders } from "./preview-headers.ts";

const identityHeaders = [
  "x-goog-iap-jwt-assertion",
  "x-goog-authenticated-user-email",
  "x-goog-authenticated-user-id",
  "x-serverless-authorization",
];

it("preserves Google application headers but strips known platform identity in both directions", () => {
  const application: Array<[string, string]> = [
    ["X-Goog-Api-Key", "application-key"],
    ["x-goog-request-params", "name=resource"],
  ];
  const headers: Array<[string, string]> = [
    ...application,
    ...identityHeaders.map((name): [string, string] => [name, "private"]),
  ];
  for (const result of [
    previewRequestHeaders(headers, "https://preview.test"),
    previewResponseHeaders(headers),
  ]) {
    expect(result).toContainEqual(["x-goog-api-key", "application-key"]);
    expect(result).toContainEqual(["x-goog-request-params", "name=resource"]);
    expect(result.some(([name]) => identityHeaders.includes(name))).toBe(false);
  }
});

it("removes spoofed/internal/hop headers and only platform cookies", () => {
  const result = previewRequestHeaders(
    [
      ["host", "evil"],
      ["connection", "x-secret"],
      ["x-secret", "hidden"],
      ["x-forwarded-host", "evil"],
      ["x-pi-orb-preview-admission", "fake"],
      ["cookie", "app=1; __Host-pi-orb-preview-session=secret"],
      ["authorization", "Bearer app"],
    ],
    "https://preview.test",
  );
  expect(result).toContainEqual(["host", "preview.test"]);
  expect(result).toContainEqual(["authorization", "Bearer app"]);
  expect(result).toContainEqual(["cookie", "app=1"]);
  expect(
    result.some(([name]) =>
      ["x-secret", "connection", "x-pi-orb-preview-admission"].includes(name),
    ),
  ).toBe(false);
});
it("drops platform collisions and Domain cookies without rewriting ordinary cookies/redirects", () => {
  const result = previewResponseHeaders([
    ["set-cookie", "app=1; Path=/"],
    ["set-cookie", "__Host-pi-orb-preview-session=evil; Secure; Path=/"],
    ["set-cookie", "app=2; Domain=preview.test"],
    ["location", "/root"],
    ["x-pi-orb-preview-admission", "private"],
    ["x-goog-authenticated-user-email", "private"],
  ]);
  expect(result).toEqual([
    ["set-cookie", "app=1; Path=/"],
    ["location", "/root"],
  ]);
});

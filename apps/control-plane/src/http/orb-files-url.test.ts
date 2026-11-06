import { expect, it } from "vitest";
import { liveFileRoute, orbFilesBaseUrl } from "./orb-files-url.ts";

const orb = "12345678-1234-4234-8234-123456789abc";
it("uses the configured fixed files origin independently of previews", () => {
  for (const provider of ["docker", "gce", "process"])
    expect(orbFilesBaseUrl("https://files.example.org", provider, orb)).toBe(
      `https://files.example.org/files/${orb}`,
    );
  expect(orbFilesBaseUrl("http://files.localhost:7100", "process", orb)).toBe(
    `http://files.localhost:7100/files/${orb}`,
  );
  expect(orbFilesBaseUrl(undefined, "docker", orb)).toBeNull();
  expect(orbFilesBaseUrl("https://files.example.org", "unknown", orb)).toBeNull();
  expect(orbFilesBaseUrl("https://files.example.org", "docker", orb.toUpperCase())).toBeNull();
});
it("extracts only a canonical orb prefix without decoding file bytes", () => {
  expect(liveFileRoute(`/files/${orb}/Review%20notes?x=1`)).toEqual({
    orbId: orb,
    path: "/Review%20notes?x=1",
  });
  for (const url of [
    `/files/${orb}`,
    `/files/${orb.toUpperCase()}/a`,
    `/files/${orb.replace("1", "%31")}/a`,
    "/s/orb/a",
    "//files/orb/a",
  ])
    expect(liveFileRoute(url)).toBeUndefined();
});

it("separates repository routes from absolute routes without decoding path bytes", () => {
  expect(liveFileRoute(`/files/repo/${orb}/Review%20notes?x=1`)).toEqual({
    orbId: orb,
    base: "repo",
    path: "/Review%20notes?x=1",
  });
  expect(liveFileRoute(`/files/${orb}/repo/README.md`)).toEqual({
    orbId: orb,
    path: "/repo/README.md",
  });
  for (const path of ["", "/a"]) {
    expect(liveFileRoute(`/files/repo/${orb.toUpperCase()}${path}`)).toBeUndefined();
    expect(liveFileRoute(`/files/repo/${orb.replace("1", "%31")}${path}`)).toBeUndefined();
  }
  expect(liveFileRoute(`/files/repo/${orb}`)).toBeUndefined();
});

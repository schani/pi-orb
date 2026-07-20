import { describe, expect, it } from "vitest";
import { validateRepositoryUrl } from "./repository-url.ts";

function expectOk(url: string): void {
  const result = validateRepositoryUrl(url);
  expect(result.isOk(), `${url} should be accepted: ${JSON.stringify(result)}`).toBe(true);
}

function expectErr(url: string, code: string): void {
  const result = validateRepositoryUrl(url);
  expect(result.isErr(), `${url} should be rejected`).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe(code);
  }
}

describe("validateRepositoryUrl", () => {
  it("accepts plain https URLs on allowlisted hosts", () => {
    expectOk("https://github.com/owner/repo");
    expectOk("https://gitlab.com/owner/repo");
    expectOk("https://bitbucket.org/owner/repo");
    expectOk("https://codeberg.org/owner/repo");
  });

  it("accepts an optional .git suffix", () => {
    expectOk("https://github.com/owner/repo.git");
  });

  it("accepts gitlab subgroup paths", () => {
    expectOk("https://gitlab.com/group/subgroup/repo");
    expectOk("https://gitlab.com/group/sub1/sub2/repo.git");
  });

  it("rejects subgroup-shaped paths on hosts without subgroups", () => {
    expectErr("https://github.com/owner/sub/repo", "invalid_repository_path");
  });

  it("normalizes and matches hostnames case-insensitively", () => {
    expectOk("https://GitHub.com/owner/repo");
  });

  it("rejects non-https schemes", () => {
    expectErr("http://github.com/owner/repo", "scheme_not_allowed");
    expectErr("git://github.com/owner/repo", "scheme_not_allowed");
    expectErr("ssh://git@github.com/owner/repo", "scheme_not_allowed");
    expectErr("file:///etc/passwd", "scheme_not_allowed");
  });

  it("rejects unparseable URLs and non-URL strings", () => {
    expectErr("not a url", "invalid_url");
    expectErr("", "invalid_url");
    expectErr("github.com/owner/repo", "invalid_url");
  });

  it("rejects hosts off the allowlist", () => {
    expectErr("https://example.com/owner/repo", "host_not_allowed");
    expectErr("https://github.com.evil.example/owner/repo", "host_not_allowed");
    expectErr("https://metadata.google.internal/computeMetadata/v1", "host_not_allowed");
  });

  it("rejects credential-bearing URLs", () => {
    expectErr("https://user@github.com/owner/repo", "userinfo_not_allowed");
    expectErr("https://user:token@github.com/owner/repo", "userinfo_not_allowed");
  });

  it("rejects explicit ports even when default", () => {
    expectErr("https://github.com:8443/owner/repo", "port_not_allowed");
  });

  it("rejects IP-literal hosts", () => {
    expectErr("https://192.168.1.1/owner/repo", "ip_literal_not_allowed");
    expectErr("https://[::1]/owner/repo", "ip_literal_not_allowed");
    expectErr("https://169.254.169.254/latest/meta-data", "ip_literal_not_allowed");
  });

  it("rejects malformed repository paths", () => {
    expectErr("https://github.com/", "invalid_repository_path");
    expectErr("https://github.com/owner", "invalid_repository_path");
    expectErr("https://github.com/owner/", "invalid_repository_path");
    expectErr("https://github.com/owner/repo/", "invalid_repository_path");
    expectErr("https://github.com//repo", "invalid_repository_path");
    expectErr("https://github.com/owner/..", "invalid_repository_path");
    expectErr("https://github.com/owner/.git", "invalid_repository_path");
    expectErr("https://github.com/owner/repo?ref=x", "invalid_repository_path");
    expectErr("https://github.com/owner/repo#frag", "invalid_repository_path");
  });

  it("returns the normalized URL string on success", () => {
    const result = validateRepositoryUrl("https://GitHub.com/Owner/Repo.git");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.url).toBe("https://github.com/Owner/Repo.git");
      expect(result.value.host).toBe("github.com");
    }
  });

  it("supports a custom host allowlist", () => {
    const result = validateRepositoryUrl("https://git.example.com/owner/repo", {
      allowedHosts: ["git.example.com"],
    });
    expect(result.isOk()).toBe(true);
    const rejected = validateRepositoryUrl("https://github.com/owner/repo", {
      allowedHosts: ["git.example.com"],
    });
    expect(rejected.isErr()).toBe(true);
  });
});

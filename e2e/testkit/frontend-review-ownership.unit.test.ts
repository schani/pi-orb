import { afterEach, expect, it, vi } from "vitest";

const files = [
  "git-identity-frontend",
  "personal-instructions-frontend",
  "frontend-listen",
  "mcp-oauth",
] as const;

async function probe(file: (typeof files)[number], failure: string, diagnosticCase = 1) {
  vi.resetModules();
  const hooks: (() => unknown)[] = [];
  const cases: (() => Promise<void>)[] = [];
  const acquired: string[] = [];
  const released: string[] = [];
  const primary = new Error(failure);
  const take = (name: string, value: unknown) => {
    if (failure === name) throw primary;
    acquired.push(name);
    return value;
  };
  const release = (name: string) => {
    released.push(name);
    if (failure === "close") throw new Error(`close ${name}`);
  };
  let routed: ((route: unknown) => Promise<void>) | undefined;
  let pending: Promise<void> | undefined;
  let gateReleased = false;
  let saves = 0;
  const gate = failure.startsWith("gate-");
  const locator = (role = "", name = ""): object =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === "then") return undefined;
        if (key === "getByRole")
          return (r: string, options: { name?: string } = {}) => locator(r, options.name);
        if (key === "route")
          return async (_path: string, handler: typeof routed) => {
            routed = handler;
          };
        if (key === "click")
          return async () => {
            if (name === "Save") saves++;
            if (
              (failure === "gate-read" && name === "Retry") ||
              (failure === "gate-write" && name === "Save" && saves === 2)
            ) {
              pending = routed?.({
                request: () => ({ method: () => (failure === "gate-read" ? "GET" : "PUT") }),
                continue: async () => {
                  gateReleased = true;
                },
                fulfill: async () => {
                  gateReleased = true;
                },
              });
              throw primary;
            }
          };
        if (key === "keyboard") return locator();
        return () => locator(role, name);
      },
      apply: () => locator(role, name),
    });
  const page = gate ? locator() : {};
  const browser = {
    newPage: async () => take("page", page),
    close: async () => release("browser"),
  };
  const vite = {
    httpServer: { address: () => ({ port: 1234 }) },
    close: async () => release("vite"),
  };
  const server = {
    listen: (_port: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 1234 }),
    closeAllConnections: vi.fn(),
    close: (done: () => void) => {
      release("server");
      done();
    },
  };
  const register = (_name: unknown, body: () => Promise<void>) => {
    cases.push(body);
  };
  const test = Object.assign(register, {
    each: () => (_name: unknown, body: (engine: string) => Promise<void>) => {
      cases.push(() => body("chromium"));
    },
    skipIf: () => register,
  });
  vi.doMock("vitest", async (original) => ({
    ...(await original<typeof import("vitest")>()),
    it: test,
    onTestFinished: (hook: () => unknown) => hooks.push(hook),
  }));
  vi.doMock("node:fs", () => ({
    existsSync: () => true,
    mkdtempSync: () => take("root", "/owned-root"),
    readFileSync: () => "certificate",
    rmSync: () => release("root"),
  }));
  vi.doMock("node:fs/promises", () => ({
    mkdtemp: async () => take("root", "/owned-root"),
    realpath: async (p: string) => p,
    writeFile: async () => {
      if (failure === "write") throw primary;
    },
    rm: async () => release("root"),
  }));
  vi.doMock("node:child_process", () => ({
    execFileSync: () => {
      if (failure === "cert") throw primary;
    },
  }));
  vi.doMock("node:https", () => ({ createServer: () => take("server", server) }));
  vi.doMock("vite", () => ({
    createServer: async () => take("vite", vite),
    build: async () => {
      if (failure === "build") throw primary;
    },
  }));
  vi.doMock("@playwright/test", () => ({
    chromium: { launch: async () => take("browser", browser) },
    webkit: {},
    expect: gate ? () => locator() : {},
  }));
  vi.doMock("./frontend-fixture.ts", () => ({
    gotoFrontendFixture: async () => undefined,
    observeFrontendBoot: () => ({}),
  }));
  vi.doMock("../frontend-listen.ts", () => ({
    listenFrontend: async () => {
      if (failure === "listen") throw primary;
    },
  }));
  let sessions = 0;
  vi.doMock("../harness.ts", () => ({
    createFakeSession: async () => {
      const sessionKey = `session${++sessions}`;
      return take(sessionKey, { sessionKey });
    },
    deleteFakeSession: async (name: string) => release(name),
    startControlPlane: async () =>
      take("cp", { baseUrl: "http://fixture", stop: async () => release("cp") }),
    api: async () => {
      if (failure === "close") throw primary;
      return release("api");
    },
  }));
  await import(`../${file}.e2e.test.ts`);
  // MCP/page succeeds only far enough to enter the scenario; that failure is
  // intentional here, so the witness exercises all registered releases.
  const body = cases[file === "frontend-listen" ? diagnosticCase : 0];
  let error: unknown;
  try {
    await body?.();
  } catch (cause) {
    error = cause;
  }
  for (const hook of hooks.toReversed()) {
    try {
      await hook();
    } catch {
      /* independent framework hooks continue */
    }
  }
  await pending;
  return { acquired, released, error, primary, gateReleased };
}

afterEach(() => {
  for (const module of [
    "vitest",
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "node:https",
    "vite",
    "@playwright/test",
    "../frontend-listen.ts",
    "./frontend-fixture.ts",
    "../harness.ts",
  ])
    vi.doUnmock(module);
});

it.each(files)("%s owns resources before browser/page startup can fail", async (file) => {
  for (const failure of ["browser", "page"]) {
    const result = await probe(file, failure);
    expect(result.error).toBe(result.primary);
    expect(result.released).toEqual(
      expect.arrayContaining(result.acquired.filter((name) => name !== "page")),
    );
  }
});

it.each(["cert", "session2", "build", "cp"])(
  "OAuth owns setup and restores environment at %s failure",
  async (failure) => {
    const cert = process.env["NODE_EXTRA_CA_CERTS"];
    const origin = process.env["PI_ORB_E2E_MCP_ORIGIN"];
    const result = await probe("mcp-oauth", failure);
    expect(result.error).toBe(result.primary);
    expect(process.env["NODE_EXTRA_CA_CERTS"]).toBe(cert);
    expect(process.env["PI_ORB_E2E_MCP_ORIGIN"]).toBe(origin);
    expect(result.released).toEqual(expect.arrayContaining(result.acquired));
  },
);

it.each(["write", "vite", "listen"])(
  "diagnostic fixture owns partial %s startup",
  async (failure) => {
    const result = await probe("frontend-listen", failure);
    expect(result.error).toBe(result.primary);
    expect(result.released).toEqual(expect.arrayContaining(result.acquired));
  },
);

it("OAuth attempts independent releases after cleanup rejections", async () => {
  const result = await probe("mcp-oauth", "close");
  expect(result.error).toBe(result.primary);
  expect(result.released).toEqual(
    expect.arrayContaining(["browser", "cp", "server", "session1", "session2", "root"]),
  );
});

it.each([1, 2])("diagnostic case %s releases every owner after close rejection", async (index) => {
  const result = await probe("frontend-listen", "close", index);
  expect(result.error).toBeDefined();
  expect(result.released).toEqual(expect.arrayContaining(["browser", "vite", "root"]));
});

it.each([
  ["git-identity-frontend", "gate-write"],
  ["personal-instructions-frontend", "gate-read"],
  ["personal-instructions-frontend", "gate-write"],
] as const)(
  "%s unconditionally releases %s after a held assertion fails",
  async (file, failure) => {
    const result = await probe(file, failure);
    expect(result.error).toBe(result.primary);
    expect(result.gateReleased).toBe(true);
  },
);

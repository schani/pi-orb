import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { expect, it } from "vitest";

const workerUrl = new URL("./bounded-worker.js", import.meta.url);

it("preserves an image larger than the text capture budget through the public worker", async () => {
  // A 1 MiB decoded image expands beyond 1 MiB on the worker pipe.
  const png = Buffer.alloc(1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const sandbox = new CodemodeSandbox({ workerUrl, memoryLimitBytes: 64 * 1024 * 1024 });
  try {
    const result = await sandbox.execute(
      `image({type:"image",data:${JSON.stringify(data)},mimeType:"image/png"}); text("preserved");`,
    );
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    expect(result.output).toEqual([
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: "preserved" },
    ]);
  } finally {
    await sandbox.close();
  }
});

it("bounds UTF-8 text independently of media and aborts outstanding callbacks", async () => {
  let cancelled = false;
  const sandbox = new CodemodeSandbox({
    workerUrl,
    memoryLimitBytes: 32 * 1024 * 1024,
    tools: [
      {
        name: "hold",
        execute: (_args, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve(undefined);
              },
              { once: true },
            );
          }),
      },
    ],
  });
  try {
    const result = await sandbox.execute(
      'tools.hold({}); const chunk="é".repeat(8192); for(let i=0;i<65;i++) text(chunk); store("mustNotPersist",true);',
    );
    expect(result.ok).toBe(false);
    expect(result.output).toHaveLength(64);
    expect(
      result.output.reduce(
        (bytes, item) => bytes + (item.type === "text" ? Buffer.byteLength(item.text) : 0),
        0,
      ),
    ).toBe(1024 * 1024);
    expect(cancelled).toBe(true);
    if (!result.ok) {
      expect(result.error.message).toContain("1 MiB text / 32 MiB aggregate / 4096 items");
      expect(result).not.toHaveProperty("storeWrites");
    }
  } finally {
    await sandbox.close();
  }
});

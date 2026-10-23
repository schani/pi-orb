import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium } from "playwright";

export async function runStudy(name, run) {
  const root = process.env.STUDY_OUTPUT_DIR || ".context/studies";
  await mkdir(root, { recursive: true });
  const outputDir = await mkdtemp(join(root, name + "-"));
  console.log(`Study artifacts: ${outputDir}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    return await run({
      browser,
      outputDir,
      artifact(name) {
        if (basename(name) !== name) throw new Error("study artifact must be a filename");
        return join(outputDir, name);
      },
    });
  } finally {
    await browser.close();
  }
}

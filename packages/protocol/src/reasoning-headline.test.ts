import { expect, it } from "vitest";
import { reasoningHeadline } from "./reasoning-headline.ts";

it("extracts ATX, setext and bold-only lines in order, flattening inline Markdown", () => {
  expect(
    reasoningHeadline(
      [
        "# Check **files** and `code` #",
        "",
        "**First [step](https://example.com)**",
        "__Second step__",
        "",
        "Setext *heading*",
        "---------------",
        "",
        "> ### Quoted heading",
        "",
        "- **List heading**",
      ].join("\n"),
    ),
  ).toBe(
    "Check files and code · First step · Second step · Setext heading · Quoted heading · List heading",
  );
});

it("ignores code, escaped markers, mixed prose and multiline bold", () => {
  expect(
    reasoningHeadline(
      [
        "```md",
        "# Fence",
        "**Fence bold**",
        "```",
        "",
        "~~~",
        "Setext fence",
        "===",
        "~~~",
        "",
        "    # Indented",
        "    **Indented bold**",
        "",
        "\\# Escaped",
        "",
        "\\*\\*Escaped bold\\*\\*",
        "",
        "prefix **not a title**",
        "",
        "**not a title** suffix",
        "",
        "**across",
        "lines**",
        "",
        "`**code**`",
        "",
        "**one** **two**",
        "",
        "| **cell** |",
        "| --- |",
      ].join("\n"),
    ),
  ).toBe("");
});

it("extracts bold-only physical lines inside a paragraph but not partial lines", () => {
  expect(reasoningHeadline("Prose\n**Title**\nMore prose\n__Next__\n**partial** text")).toBe(
    "Title · Next",
  );
});

it.each(["prefix&#10;**not a title**", "**not a title**&#10;suffix"])(
  "does not treat character-reference newlines as physical line boundaries: %s",
  (markdown) => {
    expect(reasoningHeadline(markdown)).toBe("");
  },
);

it("preserves bold-only lines across hard breaks, lists and quotes", () => {
  expect(reasoningHeadline("Prose  \n**Hard break**\\\nMore prose")).toBe("Hard break");
  expect(reasoningHeadline("- Prose\n  **List title**\n  More prose")).toBe("List title");
  expect(reasoningHeadline("> Prose\n> **Quote title**\n> More prose")).toBe("Quote title");
});

it("normalizes multiline headings and caps the joined UTF-8 headline", () => {
  expect(reasoningHeadline("Two\nline **heading**\n===")).toBe("Two line heading");
  const headline = reasoningHeadline(`# ${"😀".repeat(300)}`);
  expect(Buffer.byteLength(headline)).toBeLessThanOrEqual(1024);
  expect(headline).toBe(`${"😀".repeat(255)}…`);
});

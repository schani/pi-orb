import Testing

@testable import PiOrbModel

/// Mirrors the assistant turn the user photographed: prose with inline code, a
/// numbered question list, a fenced `bash` block, and bold in a sentence.
private let transcriptSample = """
  The gates now expose a reproducible repository workflow problem: a clean `npm ci` \
  followed by `npm run check` fails.

  Would you like me to:

  1. fix and test this developer-workflow bug now, or
  2. file a GitHub issue and continue auditing product code?

  ```bash
  npm ci
  npm run check      # fails
  ```

  The dependency audit itself reports **zero known vulnerabilities**.
  """

@Suite("markdown")
struct MarkdownTests {
  @Test func transcriptFixture() {
    #expect(
      parseMarkdown(transcriptSample) == [
        .paragraph([
          .text("The gates now expose a reproducible repository workflow problem: a clean "),
          .code("npm ci"),
          .text(" followed by "),
          .code("npm run check"),
          .text(" fails."),
        ]),
        .paragraph([.text("Would you like me to:")]),
        .list(
          ordered: true, start: 1,
          items: [
            [.paragraph([.text("fix and test this developer-workflow bug now, or")])],
            [.paragraph([.text("file a GitHub issue and continue auditing product code?")])],
          ]),
        .code(language: "bash", text: "npm ci\nnpm run check      # fails"),
        .paragraph([
          .text("The dependency audit itself reports "),
          .strong([.text("zero known vulnerabilities")]),
          .text("."),
        ]),
      ])
  }

  @Test func headingsQuotesRulesAndLinks() {
    #expect(
      parseMarkdown(
        """
        ## Findings

        > quoted *note*

        ---

        See [the docs](docs/web-ui.md).
        """) == [
        .heading(level: 2, [.text("Findings")]),
        .quote([.paragraph([.text("quoted "), .emphasis([.text("note")])])]),
        .thematicBreak,
        .paragraph([
          .text("See "),
          .link(destination: "docs/web-ui.md", [.text("the docs")]),
          .text("."),
        ]),
      ])
  }

  @Test func nestedListsKeepTheirLevels() {
    #expect(
      parseMarkdown(
        """
        - outer
          - inner
        """) == [
        .list(
          ordered: false, start: 1,
          items: [
            [
              .paragraph([.text("outer")]),
              .list(ordered: false, start: 1, items: [[.paragraph([.text("inner")])]]),
            ]
          ])
      ])
  }

  @Test func orderedListsKeepTheirStart() {
    #expect(
      parseMarkdown("3. third\n4. fourth")
        == [
          .list(
            ordered: true, start: 3,
            items: [
              [.paragraph([.text("third")])],
              [.paragraph([.text("fourth")])],
            ])
        ])
  }

  @Test func gfmTables() {
    #expect(
      parseMarkdown(
        """
        | tool | count |
        | --- | --- |
        | bash | 15 |
        """) == [
        .table(
          header: [[.text("tool")], [.text("count")]],
          rows: [[[.text("bash")], [.text("15")]]])
      ])
  }

  @Test func fencesWithoutALanguage() {
    #expect(parseMarkdown("```\nplain\n```") == [.code(language: nil, text: "plain")])
  }
}

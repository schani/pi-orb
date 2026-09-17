import Foundation
import Markdown

/// A run inside a paragraph, heading, list item or table cell.
public indirect enum MarkdownInline: Sendable, Equatable {
  case text(String)
  case code(String)
  case emphasis([MarkdownInline])
  case strong([MarkdownInline])
  case link(destination: String?, [MarkdownInline])
}

/// The block tree the transcript renders. Anything the parser produces that
/// this list cannot hold degrades to one of these cases rather than vanishing.
public indirect enum MarkdownBlock: Sendable, Equatable {
  case paragraph([MarkdownInline])
  case heading(level: Int, [MarkdownInline])
  case code(language: String?, text: String)
  case list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
  case quote([MarkdownBlock])
  case thematicBreak
  case table(header: [[MarkdownInline]], rows: [[[MarkdownInline]]])
}

/// Parses assistant Markdown into the block tree. User text, shell output and
/// tool results are never parsed: they are literal.
public func parseMarkdown(_ source: String) -> [MarkdownBlock] {
  blocks(in: Document(parsing: source))
}

private func blocks(in markup: any Markup) -> [MarkdownBlock] {
  markup.children.compactMap(block(from:))
}

private func block(from markup: any Markup) -> MarkdownBlock? {
  switch markup {
  case let node as Markdown.Paragraph:
    return .paragraph(inlines(in: node))
  case let node as Markdown.Heading:
    return .heading(level: node.level, inlines(in: node))
  case let node as Markdown.CodeBlock:
    return .code(language: node.language, text: trimTrailingNewline(node.code))
  case let node as Markdown.UnorderedList:
    return .list(ordered: false, start: 1, items: node.listItems.map(blocks(in:)))
  case let node as Markdown.OrderedList:
    return .list(ordered: true, start: Int(node.startIndex), items: node.listItems.map(blocks(in:)))
  case let node as Markdown.BlockQuote:
    return .quote(blocks(in: node))
  case is Markdown.ThematicBreak:
    return .thematicBreak
  case let node as Markdown.Table:
    return table(node)
  case let node as Markdown.HTMLBlock:
    return .code(language: "html", text: trimTrailingNewline(node.rawHTML))
  default:
    let runs = inlines(in: markup)
    return runs.isEmpty ? nil : .paragraph(runs)
  }
}

private func table(_ node: Markdown.Table) -> MarkdownBlock {
  .table(
    header: node.head.cells.map(inlines(in:)),
    rows: node.body.rows.map { $0.cells.map(inlines(in:)) })
}

private func inlines(in markup: any Markup) -> [MarkdownInline] {
  merged(markup.children.flatMap(inline(from:)))
}

private func inline(from markup: any Markup) -> [MarkdownInline] {
  switch markup {
  case let node as Markdown.Text:
    return [.text(node.string)]
  case let node as Markdown.InlineCode:
    return [.code(node.code)]
  case let node as Markdown.Emphasis:
    return [.emphasis(inlines(in: node))]
  case let node as Markdown.Strong:
    return [.strong(inlines(in: node))]
  case let node as Markdown.Link:
    return [.link(destination: node.destination, inlines(in: node))]
  case is Markdown.SoftBreak:
    return [.text(" ")]
  case is Markdown.LineBreak:
    return [.text("\n")]
  case let node as Markdown.InlineHTML:
    return [.text(node.rawHTML)]
  default:
    let children = merged(markup.children.flatMap(inline(from:)))
    return children.isEmpty ? [.text(markup.format())] : children
  }
}

/// Adjacent literal runs — a word, a soft break, the next word — are one run.
private func merged(_ runs: [MarkdownInline]) -> [MarkdownInline] {
  var results: [MarkdownInline] = []
  for run in runs {
    if case .text(let text) = run, case .text(let previous)? = results.last {
      results[results.count - 1] = .text(previous + text)
    } else {
      results.append(run)
    }
  }
  return results
}

private func trimTrailingNewline(_ text: String) -> String {
  text.hasSuffix("\n") ? String(text.dropLast()) : text
}

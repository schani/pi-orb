import AppKit
import PiOrbModel
import SwiftUI

/// The typography a design lends to rendered Markdown. Every design shares the
/// block layout below and differs only through these values.
struct MarkdownStyle {
  var body: Font = .body
  var mono: Font = .system(.callout, design: .monospaced)
  var heading: (Int) -> Font = { level in
    .system(size: level <= 1 ? 20 : level == 2 ? 17 : 15, weight: .semibold)
  }
  var link: Color = .accentColor
  var codeTint: Color = Color.secondary.opacity(0.14)
  var codeBorder: Color = .clear
  var rule: Color = Color.secondary.opacity(0.3)
  var blockSpacing: CGFloat = 10
}

struct MarkdownBlocksView: View {
  let blocks: [MarkdownBlock]
  let style: MarkdownStyle

  var body: some View {
    VStack(alignment: .leading, spacing: style.blockSpacing) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        BlockView(block: block, style: style)
      }
    }
  }
}

private struct BlockView: View {
  let block: MarkdownBlock
  let style: MarkdownStyle

  var body: some View {
    switch block {
    case .paragraph(let runs):
      Text(attributed(runs, font: style.body, style: style)).textSelection(.enabled)
    case .heading(let level, let runs):
      Text(attributed(runs, font: style.heading(level), style: style))
        .textSelection(.enabled)
    case .code(let language, let text):
      CodeBlockView(language: language, text: text, style: style)
    case .list(let ordered, let start, let items):
      ListView(ordered: ordered, start: start, items: items, style: style)
    case .quote(let inner):
      HStack(alignment: .top, spacing: 8) {
        Rectangle().fill(style.rule).frame(width: 2)
        MarkdownBlocksView(blocks: inner, style: style)
      }
    case .thematicBreak:
      Rectangle().fill(style.rule).frame(height: 1)
    case .table(let header, let rows):
      TableView(header: header, rows: rows, style: style)
    }
  }
}

private struct ListView: View {
  let ordered: Bool
  let start: Int
  let items: [[MarkdownBlock]]
  let style: MarkdownStyle

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(ordered ? "\(start + index)." : "•")
            .font(style.body)
            .monospacedDigit()
            .frame(minWidth: 16, alignment: .trailing)
          MarkdownBlocksView(blocks: item, style: style)
        }
      }
    }
    .padding(.leading, 4)
  }
}

private struct TableView: View {
  let header: [[MarkdownInline]]
  let rows: [[[MarkdownInline]]]
  let style: MarkdownStyle

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
      GridRow {
        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
          Text(attributed(cell, font: style.body.bold(), style: style))
        }
      }
      Divider().overlay(style.rule)
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
            Text(attributed(cell, font: style.body, style: style))
          }
        }
      }
    }
    .textSelection(.enabled)
  }
}

private struct CodeBlockView: View {
  let language: String?
  let text: String
  let style: MarkdownStyle

  @State private var hovering = false

  var body: some View {
    Text(text)
      .font(style.mono)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(style.codeTint)
      .overlay(Rectangle().strokeBorder(style.codeBorder, lineWidth: 1))
      .overlay(alignment: .topTrailing) {
        if hovering {
          Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .buttonStyle(.plain)
          .padding(6)
        }
      }
      .onHover { hovering = $0 }
  }
}

/// Inline runs as one attributed string: concatenation keeps wrapping and
/// selection behaving like a single paragraph.
func attributed(_ runs: [MarkdownInline], font: Font, style: MarkdownStyle) -> AttributedString {
  var result = AttributedString()
  for run in runs {
    switch run {
    case .text(let text):
      var piece = AttributedString(text)
      piece.font = font
      result += piece
    case .code(let code):
      var piece = AttributedString(code)
      piece.font = style.mono
      piece.backgroundColor = style.codeTint
      result += piece
    case .emphasis(let inner):
      result += attributed(inner, font: font.italic(), style: style)
    case .strong(let inner):
      result += attributed(inner, font: font.bold(), style: style)
    case .link(let destination, let inner):
      var piece = attributed(inner, font: font, style: style)
      piece.foregroundColor = style.link
      if let destination, let url = URL(string: destination) { piece.link = url }
      result += piece
    }
  }
  return result
}

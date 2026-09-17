import AppKit
import PiOrbModel
import SwiftUI

/// Markdown in the one 13px face: headings uppercase bold at body size, inline
/// and fenced code on `--g1`, fences keeping their 1px black border.
struct MarkdownBlocksView: View {
  let blocks: [MarkdownBlock]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        BlockView(block: block)
      }
    }
  }
}

private struct BlockView: View {
  let block: MarkdownBlock

  var body: some View {
    switch block {
    case .paragraph(let runs):
      Text(attributed(runs, font: Signal.mono)).textSelection(.enabled)
    case .heading(_, let runs):
      Text(attributed(runs.uppercased(), font: Signal.mono.bold()))
        .tracking(Signal.tracking)
        .textSelection(.enabled)
    case .code(_, let text):
      CodeBlockView(text: text)
    case .list(let ordered, let start, let items):
      ListView(ordered: ordered, start: start, items: items)
    case .quote(let inner):
      HStack(alignment: .top, spacing: 8) {
        Rectangle().fill(Signal.k).frame(width: 2)
        MarkdownBlocksView(blocks: inner)
      }
    case .thematicBreak:
      BandRule()
    case .table(let header, let rows):
      TableView(header: header, rows: rows)
    }
  }
}

private struct ListView: View {
  let ordered: Bool
  let start: Int
  let items: [[MarkdownBlock]]

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(ordered ? "\(start + index)." : "•")
            .font(Signal.mono)
            .monospacedDigit()
            .frame(minWidth: 16, alignment: .trailing)
          MarkdownBlocksView(blocks: item)
        }
      }
    }
    .padding(.leading, 4)
  }
}

private struct TableView: View {
  let header: [[MarkdownInline]]
  let rows: [[[MarkdownInline]]]

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
      GridRow {
        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
          Text(attributed(cell, font: Signal.mono.bold()))
        }
      }
      BandRule()
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
            Text(attributed(cell, font: Signal.mono))
          }
        }
      }
    }
    .textSelection(.enabled)
  }
}

/// Boxed content and a corner copy action, with no language label.
private struct CodeBlockView: View {
  let text: String

  @State private var hovering = false

  var body: some View {
    Text(text)
      .font(Signal.mono)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .padding(.trailing, 20)
      .background(Signal.g1)
      .overlay(Rectangle().strokeBorder(Signal.k, lineWidth: 1))
      .overlay(alignment: .topTrailing) {
        if hovering {
          Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .buttonStyle(IconButtonStyle())
          .help("copy")
        }
      }
      .onHover { hovering = $0 }
  }
}

extension [MarkdownInline] {
  /// Headings render uppercase; only literal text changes case.
  fileprivate func uppercased() -> [MarkdownInline] {
    map { run in
      switch run {
      case .text(let text): .text(text.uppercased())
      case .emphasis(let inner): .emphasis(inner.uppercased())
      case .strong(let inner): .strong(inner.uppercased())
      case .link(let destination, let inner): .link(destination: destination, inner.uppercased())
      case .code: run
      }
    }
  }
}

/// Inline runs as one attributed string: concatenation keeps wrapping and
/// selection behaving like a single paragraph.
func attributed(_ runs: [MarkdownInline], font: Font) -> AttributedString {
  var result = AttributedString()
  for run in runs {
    switch run {
    case .text(let text):
      var piece = AttributedString(text)
      piece.font = font
      result += piece
    case .code(let code):
      var piece = AttributedString(code)
      piece.font = Signal.mono
      piece.backgroundColor = Signal.g1
      result += piece
    case .emphasis(let inner):
      result += attributed(inner, font: font.italic())
    case .strong(let inner):
      result += attributed(inner, font: font.bold())
    case .link(let destination, let inner):
      var piece = attributed(inner, font: font)
      piece.foregroundColor = Signal.k
      piece.underlineStyle = .single
      if let destination, let url = URL(string: destination) { piece.link = url }
      result += piece
    }
  }
  return result
}

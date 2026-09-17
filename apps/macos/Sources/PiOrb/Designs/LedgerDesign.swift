import PiOrbModel
import SwiftUI

/// Built for reading a long transcript fast: a timestamp gutter, a tight line
/// box, and tool runs as aligned tabular rows — category, count, state, diff.
struct LedgerTranscript: View {
  let context: TranscriptContext

  static let gutter: CGFloat = 62
  static let ground = Color(white: 0.11)
  static let ink = Color(white: 0.90)
  static let dim = Color(white: 0.52)
  static let accent = Color(red: 0.55, green: 0.76, blue: 1.0)

  private static let text = Font.system(size: 12)
  private static let mono = Font.system(size: 11.5, design: .monospaced)

  private var style: MarkdownStyle {
    MarkdownStyle(
      body: Self.text,
      mono: Self.mono,
      heading: { _ in Self.text.weight(.semibold) },
      link: Self.accent,
      codeTint: Color(white: 0.16),
      codeBorder: .clear,
      rule: Color(white: 0.3),
      blockSpacing: 4)
  }

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: context.rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(context.rows) { row in
            LedgerRow(row: row, style: style).id(row.id)
          }
          if context.busy {
            LedgerLine(stamp: nil) {
              Text("working").font(Self.mono).foregroundStyle(Self.accent)
            }
          }
        }
        .padding(.vertical, 6)
      }
      .background(Self.ground)
      Rectangle().fill(Color(white: 0.25)).frame(height: 1)
      composer
    }
    .foregroundStyle(Self.ink)
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 8) {
      if let error = context.error {
        Text(error).font(Self.mono).foregroundStyle(.red)
      }
      TextField("", text: context.draft, axis: .vertical)
        .textFieldStyle(.plain)
        .font(Self.text)
        .tint(Self.accent)
        .lineLimit(1...4)
        .onSubmit(context.send)
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(white: 0.16))
      Button("send", action: context.send)
        .font(Self.mono)
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(context.trimmedDraft.isEmpty)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(Color(white: 0.14))
  }
}

/// One ledger line: fixed timestamp gutter, then the entry.
private struct LedgerLine<Content: View>: View {
  let stamp: Date?
  @ViewBuilder let content: Content

  private static var formatter: Date.FormatStyle {
    Date.FormatStyle(date: .omitted, time: .standard)
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(stamp.map { $0.formatted(Self.formatter) } ?? "")
        .font(.system(size: 10, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(LedgerTranscript.dim)
        .frame(width: LedgerTranscript.gutter, alignment: .trailing)
      content
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 1)
  }
}

private struct LedgerRow: View {
  let row: TranscriptRow
  let style: MarkdownStyle

  var body: some View {
    switch row.kind {
    case .userText(let text):
      LedgerLine(stamp: row.timestamp) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          tag("you", LedgerTranscript.accent)
          Text(text).font(style.body).textSelection(.enabled)
        }
      }
    case .pending(let text):
      LedgerLine(stamp: nil) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          tag("queue", LedgerTranscript.dim)
          Text(text).font(style.body).foregroundStyle(LedgerTranscript.dim)
        }
      }
    case .assistantText(let blocks), .live(let blocks):
      LedgerLine(stamp: row.timestamp) {
        MarkdownBlocksView(blocks: blocks, style: style).textSelection(.enabled)
      }
    case .tools(let group):
      LedgerToolRow(stamp: row.timestamp, group: group, style: style)
    case .shell(let command, let output):
      LedgerLine(stamp: row.timestamp) {
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            tag("sh", LedgerTranscript.dim)
            Text(command).font(style.mono)
          }
          if !output.isEmpty {
            Text(output).font(style.mono).foregroundStyle(LedgerTranscript.dim).lineLimit(12)
          }
        }
      }
    case .note(let text):
      LedgerLine(stamp: row.timestamp) {
        Text(text).font(style.body).foregroundStyle(LedgerTranscript.dim)
      }
    case .failure(let text):
      LedgerLine(stamp: row.timestamp) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          tag("fail", .red)
          Text(text).font(style.body).foregroundStyle(.red)
        }
      }
    }
  }

  private func tag(_ text: String, _ color: Color) -> some View {
    Text(text)
      .font(.system(size: 10, design: .monospaced))
      .foregroundStyle(color)
      .frame(width: 38, alignment: .leading)
  }
}

/// Category, headline, count, state and diff in fixed columns, so a run of
/// activity scans as a table rather than prose.
private struct LedgerToolRow: View {
  let stamp: Date?
  let group: ToolGroup
  let style: MarkdownStyle

  @State private var expanded = false

  private var stateColor: Color {
    switch group.status {
    case .running: LedgerTranscript.accent
    case .completed: LedgerTranscript.dim
    case .failed: .red
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      LedgerLine(stamp: stamp) {
        Button { expanded.toggle() } label: {
          HStack(spacing: 8) {
            Text(group.label)
              .foregroundStyle(LedgerTranscript.ink)
              .frame(width: 70, alignment: .leading)
            Text(group.headline ?? "")
              .foregroundStyle(LedgerTranscript.dim)
              .lineLimit(1)
              .truncationMode(.middle)
              .frame(maxWidth: 320, alignment: .leading)
            Text(ToolPresentation.metric(group) ?? "")
              .foregroundStyle(diffColor)
              .frame(width: 84, alignment: .trailing)
              .monospacedDigit()
            Text(group.trail ?? "")
              .foregroundStyle(stateColor)
              .frame(width: 72, alignment: .leading)
          }
          .font(style.mono)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
      if expanded {
        LedgerLine(stamp: nil) {
          ToolCallsView(group: group, mono: style.mono, secondary: LedgerTranscript.dim)
        }
      }
    }
  }

  private var diffColor: Color {
    if case .diff = group.metric { return LedgerTranscript.ink }
    return LedgerTranscript.dim
  }
}

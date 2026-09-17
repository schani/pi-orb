import PiOrbModel
import SwiftUI

/// Warm stock, serif prose, monochrome ink. Turns are separated by hairlines,
/// the user speaks as an indented quotation, and tool work is a small-caps
/// ledger line in the margin of the page.
struct PaperTranscript: View {
  let context: TranscriptContext

  static let stock = Color(red: 0.98, green: 0.96, blue: 0.92)
  static let ink = Color(red: 0.13, green: 0.12, blue: 0.10)
  static let faded = Color(red: 0.42, green: 0.40, blue: 0.36)
  static let rule = Color(red: 0.80, green: 0.77, blue: 0.71)

  private var style: MarkdownStyle {
    MarkdownStyle(
      body: .system(size: 15, design: .serif),
      mono: .system(size: 13, design: .monospaced),
      heading: { level in
        .system(size: level <= 1 ? 22 : level == 2 ? 18 : 16, weight: .semibold, design: .serif)
      },
      link: Self.ink,
      codeTint: Color(red: 0.94, green: 0.92, blue: 0.87),
      codeBorder: Self.rule,
      rule: Self.rule,
      blockSpacing: 12)
  }

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: context.rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(context.rows.enumerated()), id: \.element.id) { index, row in
            VStack(alignment: .leading, spacing: 0) {
              if index > 0 {
                Rectangle().fill(Self.rule).frame(height: 1).padding(.vertical, 14)
              }
              PaperRow(row: row, style: style)
            }
            .id(row.id)
          }
          if context.busy { PaperBusy().padding(.top, 18) }
        }
        .padding(.horizontal, 44)
        .padding(.vertical, 28)
        .frame(maxWidth: 780, alignment: .leading)
      }
      .background(Self.stock)
      Rectangle().fill(Self.rule).frame(height: 1)
      composer
    }
    .foregroundStyle(Self.ink)
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let error = context.error {
        Text(error).font(.system(size: 13, design: .serif))
          .foregroundStyle(Color(red: 0.55, green: 0.15, blue: 0.12))
      }
      HStack(alignment: .bottom, spacing: 12) {
        TextField("", text: context.draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(.system(size: 15, design: .serif))
          .lineLimit(1...6)
          .onSubmit(context.send)
        Button("Send", action: context.send)
          .buttonStyle(.plain)
          .font(.system(size: 13, design: .serif).smallCaps())
          .keyboardShortcut(.return, modifiers: .command)
          .disabled(context.trimmedDraft.isEmpty)
      }
      .padding(.bottom, 6)
      .overlay(alignment: .bottom) { Rectangle().fill(Self.rule).frame(height: 1) }
    }
    .padding(.horizontal, 44)
    .padding(.vertical, 18)
    .background(Self.stock)
  }
}

private struct PaperRow: View {
  let row: TranscriptRow
  let style: MarkdownStyle

  var body: some View {
    switch row.kind {
    case .userText(let text):
      quotation(text, faded: false)
    case .pending(let text):
      quotation(text, faded: true)
    case .assistantText(let blocks), .live(let blocks):
      MarkdownBlocksView(blocks: blocks, style: style).textSelection(.enabled)
    case .tools(let group):
      PaperToolLine(group: group, style: style)
    case .shell(let command, let output):
      VStack(alignment: .leading, spacing: 4) {
        Text(command).font(style.mono)
        if !output.isEmpty {
          Text(output).font(style.mono).foregroundStyle(PaperTranscript.faded)
        }
      }
      .padding(.leading, 12)
      .overlay(alignment: .leading) {
        Rectangle().fill(PaperTranscript.rule).frame(width: 1)
      }
    case .note(let text):
      Text(text).font(.system(size: 14, design: .serif).italic())
        .foregroundStyle(PaperTranscript.faded)
    case .failure(let text):
      Text(text).font(.system(size: 14, design: .serif))
        .foregroundStyle(Color(red: 0.55, green: 0.15, blue: 0.12))
    }
  }

  private func quotation(_ text: String, faded: Bool) -> some View {
    Text(text)
      .font(.system(size: 15, design: .serif))
      .foregroundStyle(faded ? PaperTranscript.faded : PaperTranscript.ink)
      .textSelection(.enabled)
      .padding(.leading, 28)
      .padding(.vertical, 2)
      .overlay(alignment: .leading) {
        Rectangle().fill(PaperTranscript.ink).frame(width: 2).padding(.trailing, 26)
      }
  }
}

private struct PaperToolLine: View {
  let group: ToolGroup
  let style: MarkdownStyle

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button { expanded.toggle() } label: {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(group.label)
            .font(.system(size: 12, design: .serif).smallCaps())
            .tracking(1.2)
          if let headline = group.headline {
            Text(headline).font(style.mono).lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 12)
          if let metric = ToolPresentation.metricLine(group) {
            Text(metric).font(.system(size: 12, design: .serif).smallCaps()).tracking(0.8)
          }
          Text(ToolPresentation.glyph(group.status)).font(.system(size: 11))
        }
        .foregroundStyle(PaperTranscript.faded)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .overlay(alignment: .bottom) {
        Rectangle().fill(PaperTranscript.rule).frame(height: 1).offset(y: 6)
      }
      if expanded {
        ToolCallsView(group: group, mono: style.mono, secondary: PaperTranscript.faded)
          .padding(.leading, 16)
          .padding(.top, 4)
      }
    }
  }
}

/// Wet ink: a single mark that breathes while the agent works.
private struct PaperBusy: View {
  @State private var dark = false

  var body: some View {
    Circle()
      .fill(PaperTranscript.ink)
      .frame(width: 7, height: 7)
      .opacity(dark ? 1 : 0.25)
      .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: dark)
      .onAppear { dark = true }
  }
}

import Combine
import PiOrbModel
import SwiftUI

/// A phosphor screen. Everything is monospace on near-black, the user speaks
/// behind a prompt, tool work reads as log lines with a status glyph, and the
/// composer is the last prompt on the screen.
struct TerminalTranscript: View {
  let context: TranscriptContext

  static let ground = Color(red: 0.04, green: 0.05, blue: 0.04)
  static let phosphor = Color(red: 0.45, green: 0.98, blue: 0.62)
  static let ink = Color(red: 0.84, green: 0.90, blue: 0.85)
  static let dim = Color(red: 0.44, green: 0.55, blue: 0.47)
  static let alarm = Color(red: 1.0, green: 0.42, blue: 0.38)

  private static let mono = Font.system(size: 12.5, design: .monospaced)

  private var style: MarkdownStyle {
    MarkdownStyle(
      body: Self.mono,
      mono: Self.mono,
      heading: { _ in Self.mono.weight(.bold) },
      link: Self.phosphor,
      codeTint: Color(red: 0.09, green: 0.12, blue: 0.10),
      codeBorder: Color(red: 0.16, green: 0.22, blue: 0.18),
      rule: Self.dim,
      blockSpacing: 8)
  }

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: context.rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 6) {
          ForEach(context.rows) { row in
            TerminalRow(row: row, style: style).id(row.id)
          }
          if context.busy { BlockCursor().padding(.top, 2) }
        }
        .padding(16)
      }
      .background(Self.ground)
      prompt
    }
    .foregroundStyle(Self.ink)
  }

  private var prompt: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let error = context.error {
        Text("!! \(error)").font(Self.mono).foregroundStyle(Self.alarm)
      }
      HStack(alignment: .top, spacing: 8) {
        Text("❯").font(Self.mono).foregroundStyle(Self.phosphor)
        TextField("", text: context.draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(Self.mono)
          .foregroundStyle(Self.ink)
          .tint(Self.phosphor)
          .lineLimit(1...8)
          .onSubmit(context.send)
          .onKeyPress(.return, phases: .down) { press in
            guard press.modifiers.contains(.command) else { return .ignored }
            context.send()
            return .handled
          }
      }
    }
    .padding(16)
    .background(Self.ground)
    .overlay(alignment: .top) { Rectangle().fill(TerminalTranscript.dim).frame(height: 1) }
  }
}

private struct TerminalRow: View {
  let row: TranscriptRow
  let style: MarkdownStyle

  var body: some View {
    switch row.kind {
    case .userText(let text):
      prefixed("❯", TerminalTranscript.phosphor) {
        Text(text).font(style.mono).foregroundStyle(TerminalTranscript.ink)
      }
    case .pending(let text):
      prefixed("❯", TerminalTranscript.dim) {
        Text(text).font(style.mono).foregroundStyle(TerminalTranscript.dim)
      }
    case .assistantText(let blocks), .live(let blocks):
      MarkdownBlocksView(blocks: blocks, style: style)
        .padding(.leading, 18)
        .textSelection(.enabled)
    case .tools(let group):
      TerminalToolLine(group: group, mono: style.mono)
    case .shell(let command, let output):
      prefixed("$", TerminalTranscript.phosphor) {
        VStack(alignment: .leading, spacing: 2) {
          Text(command).font(style.mono)
          if !output.isEmpty {
            Text(output).font(style.mono).foregroundStyle(TerminalTranscript.dim)
          }
        }
      }
    case .note(let text):
      prefixed("*", TerminalTranscript.dim) {
        Text(text).font(style.mono).foregroundStyle(TerminalTranscript.dim)
      }
    case .failure(let text):
      prefixed("!", TerminalTranscript.alarm) {
        Text(text).font(style.mono).foregroundStyle(TerminalTranscript.alarm)
      }
    }
  }

  private func prefixed(
    _ mark: String, _ color: Color, @ViewBuilder content: () -> some View
  ) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Text(mark).font(style.mono).foregroundStyle(color)
      content()
      Spacer(minLength: 0)
    }
    .textSelection(.enabled)
  }
}

private struct TerminalToolLine: View {
  let group: ToolGroup
  let mono: Font

  @State private var expanded = false

  private var color: Color {
    switch group.status {
    case .running: TerminalTranscript.dim
    case .completed: TerminalTranscript.phosphor
    case .failed: TerminalTranscript.alarm
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { expanded.toggle() } label: {
        HStack(alignment: .top, spacing: 8) {
          Text(ToolPresentation.glyph(group.status)).foregroundStyle(color)
          Text(group.label.uppercased()).foregroundStyle(color)
          if let headline = group.headline {
            Text(headline).foregroundStyle(TerminalTranscript.ink)
              .lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 12)
          if let metric = ToolPresentation.metricLine(group) {
            Text(metric).foregroundStyle(TerminalTranscript.dim)
          }
        }
        .font(mono)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        ToolCallsView(group: group, mono: mono, secondary: TerminalTranscript.dim)
          .padding(.leading, 18)
      }
    }
  }
}

/// A blinking block, the oldest activity mark there is.
private struct BlockCursor: View {
  @State private var lit = true

  private let tick = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

  var body: some View {
    Rectangle()
      .fill(TerminalTranscript.phosphor)
      .frame(width: 9, height: 16)
      .opacity(lit ? 1 : 0)
      .accessibilityLabel("Agent working")
      .onReceive(tick) { _ in lit.toggle() }
  }
}

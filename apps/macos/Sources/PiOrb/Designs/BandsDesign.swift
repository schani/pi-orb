import Combine
import PiOrbModel
import SwiftUI

/// The web UI's decided look: full-width monochrome bands, softly inverted user
/// turns, the bit-register busy marker, and a text field that inverts on focus.
struct BandsTranscript: View {
  let context: TranscriptContext

  private static let mono = Font.system(size: 13, design: .monospaced)

  private var style: MarkdownStyle {
    MarkdownStyle(
      body: Self.mono,
      mono: Self.mono,
      heading: { _ in Self.mono.weight(.bold) },
      link: .black,
      codeTint: Color(white: 0.95),
      codeBorder: .clear,
      rule: Color(white: 0.6),
      blockSpacing: 8)
  }

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: context.rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(context.rows) { row in
            BandRow(row: row, style: style).id(row.id)
          }
          if context.busy {
            BitRegister().padding(.horizontal, 20).padding(.vertical, 10)
          }
        }
      }
      .background(.white)
      Rectangle().fill(.black).frame(height: 1)
      composer
    }
    .foregroundStyle(.black)
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let error = context.error {
        Text(error).font(Self.mono).foregroundStyle(Color(red: 0.7, green: 0.1, blue: 0.1))
      }
      HStack(spacing: 8) {
        InvertingField(text: context.draft, font: Self.mono, onSubmit: context.send)
        Button("send", action: context.send)
          .buttonStyle(BandButtonStyle())
          .keyboardShortcut(.return, modifiers: .command)
          .disabled(context.trimmedDraft.isEmpty)
      }
    }
    .padding(20)
    .background(.white)
  }
}

private struct BandRow: View {
  let row: TranscriptRow
  let style: MarkdownStyle

  var body: some View {
    switch row.kind {
    case .userText(let text):
      band(inverted: true) {
        Text(text).font(style.mono).foregroundStyle(.white).textSelection(.enabled)
      }
    case .pending(let text):
      band(inverted: true) {
        Text(text).font(style.mono).foregroundStyle(Color(white: 0.7))
      }
    case .assistantText(let blocks), .live(let blocks):
      band(inverted: false) { MarkdownBlocksView(blocks: blocks, style: style) }
    case .tools(let group):
      band(inverted: false) { BandsToolRow(group: group, mono: style.mono) }
    case .shell(let command, let output):
      band(inverted: false) {
        HStack(alignment: .top, spacing: 8) {
          Text("sh").font(style.mono).foregroundStyle(Color(white: 0.4))
          VStack(alignment: .leading, spacing: 2) {
            Text("! \(command)").font(style.mono)
            if !output.isEmpty {
              Text(output).font(style.mono).foregroundStyle(Color(white: 0.33))
            }
          }
        }
      }
    case .note(let text):
      band(inverted: false) {
        Text(text).font(style.mono).foregroundStyle(Color(white: 0.33))
      }
    case .failure(let text):
      band(inverted: false) {
        Text(text).font(style.mono).foregroundStyle(Color(red: 0.7, green: 0.1, blue: 0.1))
      }
    }
  }

  private func band(inverted: Bool, @ViewBuilder content: () -> some View) -> some View {
    content()
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 20)
      .padding(.vertical, 10)
      .background(inverted ? Color.black : Color.white)
  }
}

private struct BandsToolRow: View {
  let group: ToolGroup
  let mono: Font

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        expanded.toggle()
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(expanded ? "▾" : "▸")
          Rectangle()
            .fill(group.status == .failed ? Color(red: 0.7, green: 0.1, blue: 0.1) : .black)
            .frame(width: 6, height: 6)
            .opacity(group.status == .running ? 0.4 : 1)
          Text(group.label)
          if let headline = group.headline {
            Text("· \(headline)").lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 12)
          if let metric = ToolPresentation.metricLine(group) {
            Text(metric).foregroundStyle(Color(white: 0.33))
          }
        }
        .font(mono)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        ToolCallsView(group: group, mono: mono, secondary: Color(white: 0.33))
          .padding(.leading, 16)
      }
    }
  }
}

/// Black text on white, inverting to white on black while focused.
private struct InvertingField: View {
  let text: Binding<String>
  let font: Font
  let onSubmit: () -> Void

  @FocusState private var focused: Bool

  var body: some View {
    TextField("", text: text, axis: .vertical)
      .textFieldStyle(.plain)
      .lineLimit(1...6)
      .font(font)
      .focused($focused)
      .onSubmit(onSubmit)
      .foregroundStyle(focused ? .white : .black)
      .tint(focused ? .white : .black)
      .padding(6)
      .background(focused ? Color.black : Color.white)
      .overlay(Rectangle().strokeBorder(.black, lineWidth: 1))
  }
}

private struct BandButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, design: .monospaced))
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .foregroundStyle(configuration.isPressed ? .white : .black)
      .background(configuration.isPressed ? Color.black : Color.white)
      .overlay(Rectangle().strokeBorder(.black, lineWidth: 1))
  }
}

/// The transcript's activity mark: a fixed eight-frame Gray-code strip, one
/// frame every 400ms. It is never a counter or a progress estimate.
struct BitRegister: View {
  private static let frames = ["001", "011", "010", "110", "111", "101", "100", "000"]

  @State private var index = 0

  private let tick = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

  var body: some View {
    Text(Self.frames[index])
      .font(.system(size: 13, design: .monospaced))
      .foregroundStyle(.white)
      .padding(.horizontal, 3)
      .background(.black)
      .accessibilityLabel("Agent working")
      .onReceive(tick) { _ in index = (index + 1) % Self.frames.count }
  }
}

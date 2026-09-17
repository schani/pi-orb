import Combine
import PiOrbModel
import SwiftUI

/// Full-width monochrome bands: inverted user turns, white orb turns, the
/// bit-register busy marker, and a composer that inverts on focus.
struct TranscriptView: View {
  let rows: [TranscriptRow]
  let busy: Bool
  let error: String?
  let draft: Binding<String>
  let send: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(rows) { row in
            BandRow(row: row).id(row.id)
          }
          if busy {
            BitRegister().padding(.horizontal, 20).padding(.vertical, 10)
          }
        }
      }
      .background(Signal.w)
      BandRule()
      composer
    }
    .foregroundStyle(Signal.k)
  }

  /// The web composer: a 32px prefix column, a borderless field, and the send
  /// action right-aligned on its first line.
  private var composer: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let error {
        Text(error).font(Signal.mono).foregroundStyle(Signal.bad)
      }
      HStack(alignment: .top, spacing: 12) {
        Text(">").font(Signal.mono).bold().frame(width: 32, alignment: .trailing)
        InvertingField(text: draft, bordered: false, onSubmit: send)
        Button(action: send) { SendIcon() }
          .buttonStyle(IconButtonStyle())
          .keyboardShortcut(.return, modifiers: .command)
          .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .help("send")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
    .background(Signal.w)
  }
}

/// Bottom-pinned scrolling.
private struct TranscriptScroll<Content: View>: View {
  let lastRowId: String?
  @ViewBuilder let content: Content

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        content.frame(maxWidth: .infinity, alignment: .leading)
      }
      .onChange(of: lastRowId) { _, last in
        guard let last else { return }
        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
      }
    }
  }
}

private struct BandRow: View {
  let row: TranscriptRow

  var body: some View {
    switch row.kind {
    case .userText(let text):
      band(inverted: true) {
        Text(text).font(Signal.mono).foregroundStyle(Signal.w).textSelection(.enabled)
      }
    case .pending(let text):
      band(inverted: true) {
        Text(text).font(Signal.mono).foregroundStyle(Signal.g2)
      }
    case .assistantText(let blocks), .live(let blocks):
      band(inverted: false) { MarkdownBlocksView(blocks: blocks) }
    case .tools(let group):
      band(inverted: false) { ToolRunRow(group: group) }
    case .shell(let command, let output):
      band(inverted: false) {
        HStack(alignment: .top, spacing: 8) {
          Text("sh").font(Signal.mono).foregroundStyle(Signal.g3)
          VStack(alignment: .leading, spacing: 2) {
            Text("! \(command)").font(Signal.mono)
            if !output.isEmpty {
              Text(output).font(Signal.mono).foregroundStyle(Signal.g3)
            }
          }
        }
      }
    case .note(let text):
      band(inverted: false) {
        Text(text).font(Signal.mono).foregroundStyle(Signal.g3)
      }
    case .failure(let text):
      band(inverted: false) {
        Text(text).font(Signal.mono).foregroundStyle(Signal.bad)
      }
    }
  }

  private func band(inverted: Bool, @ViewBuilder content: () -> some View) -> some View {
    content()
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 20)
      .padding(.vertical, 10)
      .background(inverted ? Signal.k : Signal.w)
  }
}

private struct ToolRunRow: View {
  let group: ToolGroup

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        expanded.toggle()
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(expanded ? "▾" : "▸")
          Rectangle()
            .fill(group.status == .failed ? Signal.bad : Signal.k)
            .frame(width: 6, height: 6)
            .opacity(group.status == .running ? 0.4 : 1)
          Text(group.label)
          if let headline = group.headline {
            Text("· \(headline)").lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 12)
          if let metric = ToolPresentation.metricLine(group) {
            Text(metric).foregroundStyle(Signal.g3)
          }
        }
        .font(Signal.mono)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expanded {
        ToolCallsView(group: group).padding(.leading, 16)
      }
    }
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
      .font(Signal.mono)
      .foregroundStyle(Signal.w)
      .padding(.horizontal, 3)
      .background(Signal.k)
      .accessibilityLabel("Agent working")
      .onReceive(tick) { _ in index = (index + 1) % Self.frames.count }
  }
}

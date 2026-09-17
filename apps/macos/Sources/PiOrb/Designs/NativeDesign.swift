import PiOrbModel
import SwiftUI

/// Stock macOS: material ground, system text, the user in trailing bubbles, and
/// tool work in ordinary disclosure rows with SF Symbols.
struct NativeTranscript: View {
  let context: TranscriptContext

  private var style: MarkdownStyle {
    MarkdownStyle(
      body: .body,
      mono: .system(.callout, design: .monospaced),
      heading: { level in
        .system(size: level <= 1 ? 20 : level == 2 ? 17 : 15, weight: .semibold)
      },
      link: .accentColor,
      codeTint: Color.secondary.opacity(0.12),
      codeBorder: .clear,
      rule: Color.secondary.opacity(0.3),
      blockSpacing: 10)
  }

  var body: some View {
    VStack(spacing: 0) {
      TranscriptScroll(lastRowId: context.rows.last?.id) {
        LazyVStack(alignment: .leading, spacing: 14) {
          ForEach(context.rows) { row in
            NativeRow(row: row, style: style).id(row.id)
          }
          if context.busy {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text("Working").foregroundStyle(.secondary)
            }
          }
        }
        .padding(16)
      }
      .background(.regularMaterial)
      Divider()
      composer
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let error = context.error {
        Label(error, systemImage: "exclamationmark.triangle")
          .font(.callout).foregroundStyle(.red)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("", text: context.draft, axis: .vertical)
          .lineLimit(1...6)
          .onSubmit(context.send)
        Button {
          context.send()
        } label: {
          Image(systemName: "arrow.up.circle.fill").imageScale(.large)
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(context.trimmedDraft.isEmpty)
      }
    }
    .padding(12)
    .background(.bar)
  }
}

private struct NativeRow: View {
  let row: TranscriptRow
  let style: MarkdownStyle

  var body: some View {
    switch row.kind {
    case .userText(let text):
      bubble(text, opacity: 1)
    case .pending(let text):
      bubble(text, opacity: 0.45)
    case .assistantText(let blocks), .live(let blocks):
      MarkdownBlocksView(blocks: blocks, style: style)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .tools(let group):
      NativeToolRow(group: group, style: style)
    case .shell(let command, let output):
      GroupBox {
        VStack(alignment: .leading, spacing: 4) {
          Label(command, systemImage: "terminal").font(style.mono)
          if !output.isEmpty {
            Text(output).font(style.mono).foregroundStyle(.secondary).lineLimit(20)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .textSelection(.enabled)
    case .note(let text):
      Text(text).font(.callout).foregroundStyle(.secondary)
    case .failure(let text):
      Label(text, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.red)
    }
  }

  private func bubble(_ text: String, opacity: Double) -> some View {
    HStack {
      Spacer(minLength: 60)
      Text(text)
        .textSelection(.enabled)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.accentColor.opacity(opacity), in: RoundedRectangle(cornerRadius: 14))
        .foregroundStyle(.white)
    }
  }
}

private struct NativeToolRow: View {
  let group: ToolGroup
  let style: MarkdownStyle

  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      ToolCallsView(group: group, mono: style.mono, secondary: .secondary)
        .padding(.top, 6)
    } label: {
      HStack(spacing: 8) {
        Image(systemName: ToolPresentation.symbol(group.category))
          .foregroundStyle(.secondary)
        Text(group.label)
        if let headline = group.headline {
          Text(headline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 8)
        if let metric = ToolPresentation.metricLine(group) {
          Text(metric).foregroundStyle(.secondary)
        }
        Image(systemName: ToolPresentation.mark(group.status))
          .foregroundStyle(group.status == .failed ? .red : .secondary)
      }
      .font(.callout)
    }
  }
}

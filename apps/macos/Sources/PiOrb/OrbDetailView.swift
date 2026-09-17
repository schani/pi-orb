import PiOrbModel
import SwiftUI

struct OrbDetailView: View {
  let orb: OrbView
  let client: ControlPlaneClient

  @State private var store: OrbStore
  @State private var draft = ""

  init(orb: OrbView, client: ControlPlaneClient) {
    self.orb = orb
    self.client = client
    _store = State(wrappedValue: OrbStore(orbId: orb.id, client: client))
  }

  var body: some View {
    VStack(spacing: 0) {
      transcript
      Divider()
      composer
    }
    .toolbar {
      ToolbarItemGroup {
        if store.busy { ProgressView().controlSize(.small) }
        Button("Start") { Task { await store.start() } }
          .disabled(orb.state == .running || orb.state == .starting)
        Button("Stop") { Task { await store.stop() } }
          .disabled(orb.state != .running && orb.state != .starting)
      }
    }
    .navigationTitle(orb.title)
    .task {
      await store.load()
      store.observe(state: orb.state)
    }
    .onChange(of: orb.state) { _, state in store.observe(state: state) }
    .onDisappear { store.disconnect() }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(store.rows) { row in
            RowView(row: row).id(row.id)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
      }
      .onChange(of: store.rows.last?.id) { _, last in
        guard let last else { return }
        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let error = store.error {
        Text(error).font(.caption).foregroundStyle(.red)
      }
      HStack {
        TextField("Message", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .onSubmit(send)
        Button("Send", action: send)
          .keyboardShortcut(.return, modifiers: .command)
          .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding()
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    Task { await store.send(text) }
  }
}

private struct RowView: View {
  let row: TranscriptRow

  var body: some View {
    switch row.kind {
    case .userText(let text):
      Text(text)
        .textSelection(.enabled)
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
    case .assistantText(let text), .live(let text):
      Text(text).textSelection(.enabled)
    case .tool(let name, let status):
      Label(name, systemImage: symbol(status))
        .font(.callout)
        .foregroundStyle(.secondary)
    case .shell(let command, let output):
      VStack(alignment: .leading, spacing: 4) {
        Text("$ \(command)")
        if !output.isEmpty { Text(output).foregroundStyle(.secondary) }
      }
      .font(.system(.caption, design: .monospaced))
      .textSelection(.enabled)
    case .note(let text):
      Text(text).font(.callout).foregroundStyle(.secondary)
    case .failure(let text):
      Text(text).font(.callout).foregroundStyle(.red)
    case .pending(let text):
      Text(text)
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        .opacity(0.5)
    }
  }

  private func symbol(_ status: ToolStatus) -> String {
    switch status {
    case .running: "circle.dotted"
    case .completed: "checkmark.circle"
    case .failed: "xmark.circle"
    }
  }
}

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
    BandsTranscript(
      context: TranscriptContext(
        rows: store.rows, busy: store.busy, error: store.error, draft: $draft, send: send))
    .toolbar {
      ToolbarItemGroup {
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

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    Task { await store.send(text) }
  }
}

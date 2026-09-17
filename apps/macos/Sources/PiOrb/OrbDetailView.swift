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
      header
      BandRule()
      TranscriptView(
        rows: store.rows, busy: store.busy, error: store.error, draft: $draft, send: send)
    }
    .task {
      await store.load()
      store.observe(state: orb.state)
    }
    .onChange(of: orb.state) { _, state in store.observe(state: state) }
    .onDisappear { store.disconnect() }
  }

  /// The web's orb header: the name, then the lifecycle cluster right-aligned.
  private var header: some View {
    HStack(spacing: 10) {
      Text(orb.title)
        .font(Signal.mono.bold())
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 10)
      Button("start") { Task { await store.start() } }
        .disabled(orb.state == .running || orb.state == .starting)
      Button("stop") { Task { await store.stop() } }
        .disabled(orb.state != .running && orb.state != .starting)
    }
    .buttonStyle(SignalButtonStyle())
    .foregroundStyle(Signal.k)
    .padding(.horizontal, 12)
    .frame(height: Signal.band)
    .background(Signal.w)
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    Task { await store.send(text) }
  }
}

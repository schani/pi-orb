import Foundation
import PiOrbModel

/// One orb's transcript: history load, live connection, composer sends.
@Observable
@MainActor
final class OrbStore {
  let orbId: String
  private(set) var rows: [TranscriptRow] = []
  private(set) var busy = false
  private(set) var connection: LiveStatus = .closed
  private(set) var error: String?

  private let client: ControlPlaneClient
  private var reducer = TranscriptReducer()
  private var pending: [PendingMessage] = []
  private var live: LiveConnection?
  private var running = false

  init(orbId: String, client: ControlPlaneClient) {
    self.orbId = orbId
    self.client = client
  }

  func load() async {
    do {
      reducer.load(try await client.history(orbId: orbId))
      error = nil
    } catch {
      self.error = describe(error)
    }
    project()
  }

  /// Connects while the orb runs and disconnects when it stops.
  func observe(state: OrbState) {
    let shouldRun = state == .running
    guard shouldRun != running else { return }
    running = shouldRun
    if shouldRun { connect() } else { disconnect() }
  }

  func disconnect() {
    live?.stop()
    live = nil
    running = false
  }

  func send(_ text: String) async {
    let message = PendingMessage(id: UUID().uuidString.lowercased(), text: text)
    pending.append(message)
    project()
    do {
      try await client.enqueueMessage(orbId: orbId, messageId: message.id, text: text)
      error = nil
    } catch {
      pending.removeAll { $0.id == message.id }
      self.error = describe(error)
      project()
    }
  }

  func start() async {
    do {
      try await client.start(orbId: orbId)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  func stop() async {
    do {
      try await client.stop(orbId: orbId)
      error = nil
    } catch {
      self.error = describe(error)
    }
  }

  private func connect() {
    let connection = LiveConnection(
      url: client.liveURL(orbId: orbId),
      afterRecordId: { [weak self] in self?.reducer.state.afterRecordId },
      onEvent: { [weak self] event in self?.apply(event) })
    live = connection
    connection.start()
  }

  private func apply(_ event: LiveEvent) {
    switch event {
    case .status(let status):
      connection = status
    case .frame(let frame):
      reducer.apply(frame)
      project()
    }
  }

  private func project() {
    let represented = Set(
      reducer.state.records.flatMap { record -> [String] in
        guard case .message(let message) = record.body else { return [] }
        return message.inboxMessageIds
      })
    pending.removeAll { represented.contains($0.id) }
    rows = present(reducer.state, pending: pending)
    busy = reducer.state.activity == .busy
    if let failure = reducer.state.error { error = failure }
  }
}

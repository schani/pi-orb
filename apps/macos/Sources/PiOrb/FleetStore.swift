import Foundation
import PiOrbModel

struct ProjectOrbs: Identifiable, Equatable {
  let project: ProjectView
  var orbs: [OrbView]

  var id: String { project.id }
}

/// Sidebar contents, refreshed while the window is open.
@Observable
@MainActor
final class FleetStore {
  private(set) var projects: [ProjectOrbs] = []
  private(set) var error: String?

  private let client: ControlPlaneClient
  private var poll: Task<Void, Never>?

  init(client: ControlPlaneClient) {
    self.client = client
  }

  func startPolling() {
    guard poll == nil else { return }
    poll = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }

  func stopPolling() {
    poll?.cancel()
    poll = nil
  }

  func orb(_ id: String) -> OrbView? {
    projects.lazy.flatMap(\.orbs).first { $0.id == id }
  }

  private func refresh() async {
    do {
      var loaded: [ProjectOrbs] = []
      for project in try await client.projects() {
        loaded.append(
          ProjectOrbs(project: project, orbs: try await client.orbs(projectId: project.id)))
      }
      projects = loaded
      error = nil
    } catch {
      self.error = describe(error)
    }
  }
}

func describe(_ error: ApiError) -> String {
  switch error {
  case .transport(let message): message
  case .status(let code, let message): message.isEmpty ? "HTTP \(code)" : message
  case .decoding(let message): message
  }
}

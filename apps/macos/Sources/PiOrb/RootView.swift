import PiOrbModel
import SwiftUI

struct RootView: View {
  let fleet: FleetStore
  let client: ControlPlaneClient
  @State private var selection: String?

  var body: some View {
    NavigationSplitView {
      List(fleet.projects, selection: $selection) { entry in
        Section(entry.project.name) {
          ForEach(entry.orbs) { orb in
            OrbRow(orb: orb).tag(orb.id)
          }
        }
      }
      .navigationSplitViewColumnWidth(min: 220, ideal: 260)
      .overlay(alignment: .bottom) {
        if let error = fleet.error {
          Text(error).font(.caption).foregroundStyle(.red).padding(6)
        }
      }
    } detail: {
      if let selection, let orb = fleet.orb(selection) {
        OrbDetailView(orb: orb, client: client).id(selection)
      } else {
        Text("No orb selected").foregroundStyle(.secondary)
      }
    }
    .task {
      fleet.startPolling()
    }
  }
}

private struct OrbRow: View {
  let orb: OrbView

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(orb.title)
      Text(stateText).font(.caption).foregroundStyle(.secondary)
    }
  }

  private var stateText: String {
    guard let activity = orb.activity, orb.state == .running else { return orb.state.rawValue }
    return "\(orb.state.rawValue) · \(activity.rawValue)"
  }
}

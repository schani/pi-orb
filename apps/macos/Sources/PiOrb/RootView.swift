import PiOrbModel
import SwiftUI

struct RootView: View {
  let fleet: FleetStore
  let client: ControlPlaneClient
  @State private var selection: String?

  var body: some View {
    NavigationSplitView {
      sidebar
        .navigationSplitViewColumnWidth(236)
        .toolbar(removing: .sidebarToggle)
        .ignoresSafeArea(.container, edges: .top)
    } detail: {
      detail.ignoresSafeArea(.container, edges: .top)
    }
    .task {
      fleet.startPolling()
    }
    .onChange(of: fleet.projects) { _, projects in
      let orbs = projects.flatMap(\.orbs)
      if !orbs.contains(where: { $0.id == selection }) { selection = orbs.first?.id }
    }
  }

  @ViewBuilder private var detail: some View {
    if let selection, let orb = fleet.orb(selection) {
      OrbDetailView(orb: orb, client: client).id(selection)
    } else {
      Signal.w
    }
  }

  /// The web's orb index: the traffic lights fill the top band, then each
  /// project's name labels its orbs.
  private var sidebar: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: Signal.band)
      BandRule()
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
          ForEach(fleet.projects) { entry in
            Section {
              ForEach(entry.orbs) { orb in
                OrbRow(orb: orb, selected: orb.id == selection) { selection = orb.id }
              }
            } header: {
              ProjectLabel(name: entry.project.name, first: entry.id == fleet.projects.first?.id)
            }
          }
        }
      }
      if let error = fleet.error {
        BandRule()
        Text(error)
          .font(Signal.mono)
          .foregroundStyle(Signal.bad)
          .padding(.horizontal, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(Signal.w)
    .overlay(alignment: .trailing) { Signal.k.frame(width: 1) }
  }
}

private struct ProjectLabel: View {
  let name: String
  let first: Bool

  var body: some View {
    VStack(spacing: 0) {
      if !first { BandRule() }
      Text(name.uppercased())
        .font(Signal.mono.bold())
        .tracking(Signal.tracking)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, minHeight: Signal.row, alignment: .leading)
        .padding(.horizontal, 10)
      BandRule()
    }
    .background(Signal.w)
  }
}

private struct OrbRow: View {
  let orb: OrbView
  let selected: Bool
  let select: () -> Void

  @State private var hovering = false

  var body: some View {
    let glyph = OrbGlyph.of(orb.state, orb.activity)
    Button(action: select) {
      HStack(spacing: 8) {
        StateTile(glyph: glyph, label: label(glyph))
        Text(orb.title)
          .font(selected ? Signal.mono.bold() : Signal.mono)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .frame(maxWidth: .infinity, minHeight: Signal.row, alignment: .leading)
      .padding(.horizontal, 10)
      .foregroundStyle(selected ? Signal.w : Signal.k)
      .background(selected ? Signal.k : hovering ? Signal.g1 : Signal.w)
      .overlay(alignment: .leading) { glyph.hue.frame(width: 2) }
      .overlay(alignment: .bottom) { BandRule(color: Signal.g1) }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }

  private func label(_ glyph: OrbGlyph) -> String {
    glyph == .busy ? "busy" : orb.state.rawValue
  }
}

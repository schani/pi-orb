import AppKit
import PiOrbModel
import SwiftUI

@main
struct PiOrbApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @AppStorage(TranscriptDesign.storageKey) private var design = TranscriptDesign.bands
  @State private var fleet = FleetStore(client: ControlPlaneClient.fromEnvironment())

  var body: some Scene {
    WindowGroup {
      RootView(fleet: fleet, client: ControlPlaneClient.fromEnvironment())
    }
    .defaultSize(width: 1000, height: 700)
    .commands {
      CommandGroup(after: .toolbar) {
        Menu("Design") {
          Picker("Design", selection: $design) {
            ForEach(TranscriptDesign.allCases) { Text($0.title).tag($0) }
          }
          .pickerStyle(.inline)
        }
      }
    }
  }
}

/// A SwiftPM executable has no bundle, so it starts as an accessory process.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

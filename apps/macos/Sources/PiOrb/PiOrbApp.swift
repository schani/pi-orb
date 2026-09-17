import AppKit
import PiOrbModel
import SwiftUI

@main
struct PiOrbApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var fleet = FleetStore(client: ControlPlaneClient.fromEnvironment())

  var body: some Scene {
    WindowGroup {
      RootView(fleet: fleet, client: ControlPlaneClient.fromEnvironment())
    }
    .defaultSize(width: 1000, height: 700)
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

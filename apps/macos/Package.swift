// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "PiOrb",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "PiOrbModel"),
        .executableTarget(name: "PiOrb", dependencies: ["PiOrbModel"]),
        .testTarget(name: "PiOrbModelTests", dependencies: ["PiOrbModel"]),
    ]
)

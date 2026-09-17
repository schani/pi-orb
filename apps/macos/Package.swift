// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "PiOrb",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", branch: "release/6.4.x")
    ],
    targets: [
        .target(
            name: "PiOrbModel",
            dependencies: [.product(name: "Markdown", package: "swift-markdown")]),
        .executableTarget(name: "PiOrb", dependencies: ["PiOrbModel"]),
        .testTarget(name: "PiOrbModelTests", dependencies: ["PiOrbModel"]),
    ]
)

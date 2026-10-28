// swift-tools-version:5.10
// Owned by the Core agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Core",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartCore", targets: ["EngelbartCore"])],
    dependencies: [
    ],
    targets: [
        .target(name: "EngelbartCore", dependencies: []),
        .testTarget(name: "EngelbartCoreTests", dependencies: ["EngelbartCore"]),
    ]
)

// swift-tools-version:5.10
// Owned by the UI agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "UI",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartUI", targets: ["EngelbartUI"])],
    dependencies: [
        .package(path: "../Core"),
    ],
    targets: [
        .target(name: "EngelbartUI", dependencies: [.product(name: "EngelbartCore", package: "Core"), ], resources: [.copy("Resources")]),
        .testTarget(name: "EngelbartUITests", dependencies: ["EngelbartUI"]),
    ]
)

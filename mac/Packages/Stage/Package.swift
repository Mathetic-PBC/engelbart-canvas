// swift-tools-version:5.10
// Owned by the Stage agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Stage",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartStage", targets: ["EngelbartStage"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Doc"),
    ],
    targets: [
        .target(name: "EngelbartStage", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartDoc", package: "Doc"), ]),
        .testTarget(name: "EngelbartStageTests", dependencies: ["EngelbartStage"]),
    ]
)

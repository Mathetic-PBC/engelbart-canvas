// swift-tools-version:5.10
// Owned by the Tools agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Tools",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartTools", targets: ["EngelbartTools"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
    ],
    targets: [
        .target(name: "EngelbartTools", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), ]),
        .testTarget(name: "EngelbartToolsTests", dependencies: ["EngelbartTools"]),
    ]
)

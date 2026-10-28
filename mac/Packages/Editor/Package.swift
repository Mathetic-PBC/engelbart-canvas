// swift-tools-version:5.10
// Owned by the Editor agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Editor",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartEditor", targets: ["EngelbartEditor"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../Doc"),
        .package(path: "../UI"),
    ],
    targets: [
        .target(name: "EngelbartEditor", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartDoc", package: "Doc"), .product(name: "EngelbartUI", package: "UI"), ]),
        .testTarget(name: "EngelbartEditorTests", dependencies: ["EngelbartEditor"]),
    ]
)

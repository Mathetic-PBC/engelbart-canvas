// swift-tools-version:5.10
// Owned by the Store agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Store",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartStore", targets: ["EngelbartStore"])],
    dependencies: [
        .package(path: "../Core"),
    ],
    targets: [
        .target(name: "EngelbartStore", dependencies: [.product(name: "EngelbartCore", package: "Core"), ]),
        .testTarget(name: "EngelbartStoreTests", dependencies: ["EngelbartStore"]),
    ]
)

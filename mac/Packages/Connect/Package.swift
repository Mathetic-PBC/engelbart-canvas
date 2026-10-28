// swift-tools-version:5.10
// Owned by the Connect agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Connect",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartConnect", targets: ["EngelbartConnect"])],
    dependencies: [
        .package(path: "../Core"),
    ],
    targets: [
        .target(name: "EngelbartConnect", dependencies: [.product(name: "EngelbartCore", package: "Core"), ]),
        .testTarget(name: "EngelbartConnectTests", dependencies: ["EngelbartConnect"]),
    ]
)

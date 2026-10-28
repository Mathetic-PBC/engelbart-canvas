// swift-tools-version:5.10
// Owned by the Doc agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Doc",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartDoc", targets: ["EngelbartDoc"])],
    dependencies: [
        .package(path: "../Core"),
    ],
    targets: [
        .target(name: "EngelbartDoc", dependencies: [.product(name: "EngelbartCore", package: "Core"), ]),
        .testTarget(name: "EngelbartDocTests", dependencies: ["EngelbartDoc"]),
    ]
)

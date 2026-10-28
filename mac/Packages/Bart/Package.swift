// swift-tools-version:5.10
// Owned by the Bart agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Bart",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartBart", targets: ["EngelbartBart"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../Doc"),
    ],
    targets: [
        .target(name: "EngelbartBart", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartDoc", package: "Doc"), ]),
        .testTarget(name: "EngelbartBartTests", dependencies: ["EngelbartBart"]),
    ]
)

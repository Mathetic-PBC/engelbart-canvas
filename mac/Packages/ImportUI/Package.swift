// swift-tools-version:5.10
// Owned by the ImportUI agent (wave 2). See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "ImportUI",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartImportUI", targets: ["EngelbartImportUI"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Store"),
        .package(path: "../Connect"),
    ],
    targets: [
        .target(name: "EngelbartImportUI", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartConnect", package: "Connect")]),
        .testTarget(name: "EngelbartImportUITests", dependencies: ["EngelbartImportUI"]),
    ]
)

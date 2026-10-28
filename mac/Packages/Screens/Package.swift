// swift-tools-version:5.10
// Owned by the Screens agent (wave 2). See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Screens",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartScreens", targets: ["EngelbartScreens"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Store"),
        .package(path: "../Doc"),
        .package(path: "../Integrations"),
        .package(path: "../Tools"),
    ],
    targets: [
        .target(name: "EngelbartScreens", dependencies: [
            .product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"),
            .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartDoc", package: "Doc"),
            .product(name: "EngelbartIntegrations", package: "Integrations"), .product(name: "EngelbartTools", package: "Tools"),
        ]),
        .testTarget(name: "EngelbartScreensTests", dependencies: [
            "EngelbartScreens",
            .product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"),
            .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartDoc", package: "Doc"),
            .product(name: "EngelbartIntegrations", package: "Integrations"), .product(name: "EngelbartTools", package: "Tools"),
        ]),
    ]
)

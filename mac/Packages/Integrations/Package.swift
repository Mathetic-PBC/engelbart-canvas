// swift-tools-version:5.10
// Owned by the Integrations agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Integrations",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartIntegrations", targets: ["EngelbartIntegrations"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
    ],
    targets: [
        .target(name: "EngelbartIntegrations", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), ]),
        .testTarget(name: "EngelbartIntegrationsTests", dependencies: ["EngelbartIntegrations"]),
    ]
)

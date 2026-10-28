// swift-tools-version:5.10
// Owned by the Sidebar agent (wave 2). See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Sidebar",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartSidebar", targets: ["EngelbartSidebar"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Store"),
        .package(path: "../Doc"),
        .package(path: "../Integrations"),
    ],
    targets: [
        .target(name: "EngelbartSidebar", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartDoc", package: "Doc"), .product(name: "EngelbartIntegrations", package: "Integrations"), ]),
        .testTarget(name: "EngelbartSidebarTests", dependencies: ["EngelbartSidebar"]),
    ]
)

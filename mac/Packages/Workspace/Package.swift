// swift-tools-version:5.10
// Owned by the Workspace agent (wave 2). See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Workspace",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartWorkspace", targets: ["EngelbartWorkspace"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Store"),
        .package(path: "../Doc"),
        .package(path: "../Editor"),
        .package(path: "../Bart"),
        .package(path: "../Build"),
        .package(path: "../Terminal"),
        .package(path: "../Tools"),
        .package(path: "../Stage"),
        .package(path: "../PDF"),
        .package(path: "../Sandbox"),
        .package(path: "../Integrations"),
    ],
    targets: [
        .target(name: "EngelbartWorkspace", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartDoc", package: "Doc"), .product(name: "EngelbartEditor", package: "Editor"), .product(name: "EngelbartBart", package: "Bart"), .product(name: "EngelbartBuild", package: "Build"), .product(name: "EngelbartTerminal", package: "Terminal"), .product(name: "EngelbartTools", package: "Tools"), .product(name: "EngelbartStage", package: "Stage"), .product(name: "EngelbartPDF", package: "PDF"), .product(name: "EngelbartSandbox", package: "Sandbox"), .product(name: "EngelbartIntegrations", package: "Integrations"), ]),
        .testTarget(name: "EngelbartWorkspaceTests", dependencies: ["EngelbartWorkspace"]),
    ]
)

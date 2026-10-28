// swift-tools-version:5.10
// Owned by the App shell agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
//
// The app: `EngelbartApp` holds everything (so it can be tested), `Engelbart` is the executable that starts it.
// Wave 1 depends only on Core and UI. WAVE 2: add the feature packages here (Store, Doc, Editor, Bart, Build, Terminal,
// Tools, Stage, PDF, Sandbox, Connect, Integrations) and plug them into the slots listed in mac/Engelbart/API.md.
import PackageDescription

let package = Package(
    name: "Engelbart",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Engelbart", targets: ["Engelbart"]),
        .library(name: "EngelbartApp", targets: ["EngelbartApp"]),
    ],
    dependencies: [
        .package(path: "../Packages/Core"),
        .package(path: "../Packages/UI"),
    ],
    targets: [
        .target(name: "EngelbartApp", dependencies: [
            .product(name: "EngelbartCore", package: "Core"),
            .product(name: "EngelbartUI", package: "UI"),
        ]),
        .executableTarget(name: "Engelbart", dependencies: ["EngelbartApp"]),
        .testTarget(name: "EngelbartAppTests", dependencies: ["EngelbartApp"]),
    ]
)

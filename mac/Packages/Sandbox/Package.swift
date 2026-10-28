// swift-tools-version:5.10
// Owned by the Sandbox agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Sandbox",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartSandbox", targets: ["EngelbartSandbox"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
    ],
    targets: [
        .target(
            name: "EngelbartSandbox",
            dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI")],
            // The Python helpers the sandbox runs (src/main/sandbox/*.py), byte-identical copies.
            resources: [.copy("Resources")],
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(name: "EngelbartSandboxTests", dependencies: ["EngelbartSandbox"]),
    ]
)

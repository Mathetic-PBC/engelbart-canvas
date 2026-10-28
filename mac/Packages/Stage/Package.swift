// swift-tools-version:5.10
// Owned by the Stage agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Stage",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartStage", targets: ["EngelbartStage"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        // Doc is not a dependency (2026-10-28): the Stage needs only web-name, passage-link/-text and markdown from it,
        // keeps its own copies (Model/AddressKey.swift, Model/Passage.swift), and so builds while Doc is being written.
    ],
    targets: [
        .target(
            name: "EngelbartStage",
            dependencies: [
                .product(name: "EngelbartCore", package: "Core"),
                .product(name: "EngelbartUI", package: "UI"),
            ],
            resources: [.copy("Resources")],
            linkerSettings: [.linkedLibrary("sqlite3"), .linkedFramework("WebKit"), .linkedFramework("Security")]
        ),
        .testTarget(name: "EngelbartStageTests", dependencies: ["EngelbartStage"]),
    ]
)

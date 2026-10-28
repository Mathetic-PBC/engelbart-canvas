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
        // Doc (2026-10-28): one definition of kind.js, passage-link/-text, address-key, markdown, selection-card,
        // mark-answers' withAsk and web-name, shared with the editor.
        .package(path: "../Doc"),
    ],
    targets: [
        .target(
            name: "EngelbartStage",
            dependencies: [
                .product(name: "EngelbartCore", package: "Core"),
                .product(name: "EngelbartUI", package: "UI"),
                .product(name: "EngelbartDoc", package: "Doc"),
            ],
            resources: [.copy("Resources")],
            linkerSettings: [.linkedLibrary("sqlite3"), .linkedFramework("WebKit"), .linkedFramework("Security")]
        ),
        .testTarget(name: "EngelbartStageTests", dependencies: ["EngelbartStage", .product(name: "EngelbartDoc", package: "Doc")]),
    ]
)

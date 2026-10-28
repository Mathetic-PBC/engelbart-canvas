// swift-tools-version:5.10
// Owned by the Editor agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Editor",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartEditor", targets: ["EngelbartEditor"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../Doc"),
        .package(path: "../UI"),
        // Math typeset as KaTeX did (fractions, roots, matrices, big operators): MTMathImage (2026-10-28, coordinator).
        .package(url: "https://github.com/mgriebling/SwiftMath", from: "1.7.3"),
    ],
    targets: [
        .target(name: "EngelbartEditor", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartDoc", package: "Doc"), .product(name: "EngelbartUI", package: "UI"), .product(name: "SwiftMath", package: "SwiftMath"), ]),
        .testTarget(name: "EngelbartEditorTests", dependencies: ["EngelbartEditor"]),
    ]
)

// swift-tools-version:5.10
// Owned by the PDF agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "PDF",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartPDF", targets: ["EngelbartPDF"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        // Doc holds the one definition of selection-card, mark-answers, mentions, citations and the passage fold.
        .package(path: "../Doc"),
    ],
    targets: [
        .target(name: "EngelbartPDF", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartDoc", package: "Doc")]),
        // Fixtures/rough-highlights.json is rough.js 4.6.6's own output for highlights (rough-highlights.gen.mjs beside it).
        .testTarget(name: "EngelbartPDFTests", dependencies: ["EngelbartPDF"], resources: [.copy("Fixtures")]),
    ]
)

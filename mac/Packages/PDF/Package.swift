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
    ],
    targets: [
        .target(name: "EngelbartPDF", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), ]),
        .testTarget(name: "EngelbartPDFTests", dependencies: ["EngelbartPDF"]),
    ]
)

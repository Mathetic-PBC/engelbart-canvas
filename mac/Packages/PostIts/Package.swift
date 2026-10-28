// swift-tools-version:5.10
// Owned by the PostIts agent (wave 2). See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "PostIts",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartPostIts", targets: ["EngelbartPostIts"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(path: "../Store"),
        .package(path: "../Doc"),
        .package(path: "../Editor"),
        .package(path: "../Build"),
    ],
    targets: [
        .target(name: "EngelbartPostIts", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "EngelbartStore", package: "Store"), .product(name: "EngelbartDoc", package: "Doc"), .product(name: "EngelbartEditor", package: "Editor"), .product(name: "EngelbartBuild", package: "Build"), ]),
        .testTarget(name: "EngelbartPostItsTests", dependencies: ["EngelbartPostIts"]),
    ]
)

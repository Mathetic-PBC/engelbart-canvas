// swift-tools-version:5.10
// Owned by the Build agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
// Doc is allowed by the architecture but not used: what Build needs of the document model (mention expansion, the
// catalog) comes through BuildHost, so a half-finished edit in Doc can never break this package's build.
import PackageDescription

let package = Package(
    name: "Build",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartBuild", targets: ["EngelbartBuild"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
    ],
    targets: [
        .target(name: "EngelbartBuild", dependencies: [
            .product(name: "EngelbartCore", package: "Core"),
            .product(name: "EngelbartUI", package: "UI"),
        ]),
        .testTarget(name: "EngelbartBuildTests", dependencies: ["EngelbartBuild"]),
    ]
)

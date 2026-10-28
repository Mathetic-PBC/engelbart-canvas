// swift-tools-version:5.10
// Owned by the Bart agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
//
// Depends on Core alone. What it needs of Doc (context/expand-mentions: the documents with their mentions expanded,
// projectSource, imagePaths) comes in through the `BartDocuments` protocol the app implements with EngelbartDoc, so a
// half-finished Doc never breaks this build (see API.md, "Needs from other packages").
import PackageDescription

let package = Package(
    name: "Bart",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartBart", targets: ["EngelbartBart"])],
    dependencies: [
        .package(path: "../Core"),
    ],
    targets: [
        .target(name: "EngelbartBart", dependencies: [.product(name: "EngelbartCore", package: "Core")]),
        .testTarget(name: "EngelbartBartTests", dependencies: ["EngelbartBart"]),
    ]
)

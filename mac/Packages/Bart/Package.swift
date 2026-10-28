// swift-tools-version:5.10
// Owned by the Bart agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
//
// Depends on Core and Doc. Doc holds the one definition of what main and the editor share: the line reader
// (question.cjs), passage links and text (shared/passage-*.cjs), address keys, mark answers and the editor's routing
// rules. expand-mentions itself reaches Bart through `BartStore.expandDoc` (the Store resolves mentions with Doc's
// ExpandMentions), so Bart never reads the Store.
import PackageDescription

let package = Package(
    name: "Bart",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartBart", targets: ["EngelbartBart"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../Doc"),
    ],
    targets: [
        .target(name: "EngelbartBart", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartDoc", package: "Doc")]),
        .testTarget(name: "EngelbartBartTests", dependencies: ["EngelbartBart", .product(name: "EngelbartDoc", package: "Doc")]),
    ]
)

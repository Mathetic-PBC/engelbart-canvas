// swift-tools-version:5.10
// Owned by the Terminal agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Terminal",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartTerminal", targets: ["EngelbartTerminal"])],
    dependencies: [
        .package(path: "../Core"),
        .package(path: "../UI"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0"),
    ],
    targets: [
        .target(name: "EngelbartTerminal", dependencies: [.product(name: "EngelbartCore", package: "Core"), .product(name: "EngelbartUI", package: "UI"), .product(name: "SwiftTerm", package: "SwiftTerm"), ]),
        .testTarget(name: "EngelbartTerminalTests", dependencies: ["EngelbartTerminal"]),
    ]
)

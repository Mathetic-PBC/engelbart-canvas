// swift-tools-version:5.10
// Owned by the Connect agent. See mac/ARCHITECTURE.md. (tools-version 5.10 = Swift 5 language mode)
import PackageDescription

let package = Package(
    name: "Connect",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EngelbartConnect", targets: ["EngelbartConnect"])],
    dependencies: [
        .package(path: "../Core"),
        // ../UI is left out on purpose: the sign-in windows are a web page in a plain window (white, as Electron's
        // backgroundColor '#ffffff'), and building against another agent's in-progress UI package broke this one.
    ],
    targets: [
        .target(name: "EngelbartConnect", dependencies: [.product(name: "EngelbartCore", package: "Core")], resources: [.copy("Resources/trace.html")]),
        .testTarget(name: "EngelbartConnectTests", dependencies: ["EngelbartConnect"]),
    ]
)

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "bean-claude-observer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "bean-claude-observer", targets: ["bean-claude-observer"])
    ],
    targets: [
        .executableTarget(
            name: "bean-claude-observer",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Foundation"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)

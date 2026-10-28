import Foundation

// Engelbart's own Git (src/main/tools/bundled-git.cjs, 2026-09-28): dugite-native's build of Git, the one GitHub Desktop
// ships, inside the app at Contents/Resources/git, or in a checkout at vendor/git/darwin-<arch> (both put there by
// scripts/fetch-git.mjs). It stands in when the person has no Git of their own that works (Detect.swift): on a Mac without
// Apple's developer tools /usr/bin/git is a stub that opens Apple's installer, which can take the better part of an hour.
// It is run through its launcher, engelbart-bin/git, which tells it where its helpers and templates are; while it stands
// in, that folder goes first on PATH for everything Engelbart starts (ENGELBART_GIT_BIN, Manager.environment), so Claude
// Code and Codex find it and never reach Apple's stub. A person's own Git, once they have one, is used instead.

public let BUNDLED_GIT_LAUNCHER = "engelbart-bin/git"

public enum BundledGit {
    /// This Mac's architecture as Node names it (arm64 | x64).
    public static var arch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    /// The launcher of the Git that came with Engelbart, or nil. `resourcesPath`: the app bundle's Resources folder;
    /// `appRoot`: a checkout; `override`: ENGELBART_BUNDLED_GIT, a folder laid out the same way (tests). Macs only.
    public static func find(resourcesPath: String? = Bundle.main.resourcePath, appRoot: String? = nil, arch: String = BundledGit.arch,
                            platform: String = "darwin", override: String? = ProcessInfo.processInfo.environment["ENGELBART_BUNDLED_GIT"]) -> String? {
        let override = (override?.isEmpty ?? true) ? nil : override
        if platform != "darwin" && override == nil { return nil }
        let folders: [String?] = override.map { [$0] } ?? [resourcesPath.map { ($0 as NSString).appendingPathComponent("git") },
                                                          appRoot.map { ($0 as NSString).appendingPathComponent("vendor/git/darwin-\(arch)") }]
        for folder in folders.compactMap({ $0 }) {
            let launcher = (folder as NSString).appendingPathComponent(BUNDLED_GIT_LAUNCHER)
            if ToolShell.isExecutableFile(launcher) { return launcher }
        }
        return nil
    }
}

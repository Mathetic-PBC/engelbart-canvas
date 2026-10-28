import Foundation

/// The Stage's bundled files.
public enum StageResources {
    /// Resources/page.js: the script every Stage page runs (the Electron page-preload.cjs, ported).
    public static let pageScript: String = {
        let url = Bundle.module.url(forResource: "page", withExtension: "js", subdirectory: "Resources")
            ?? Bundle.module.resourceURL?.appendingPathComponent("Resources/page.js")
        return url.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
    }()
}

import AppKit
import EngelbartUI

// Import your context's pictures (src/renderer/import/logos.js, 2026-10-13): the apps' logos (design/assets/logos, the
// mockup's own), the supported browsers' icons (design/assets/logos/browsers) and the providers'. Copied into this
// package's Resources/logos; drawn by NSImage (SVG on macOS 14+). Keyed by app id: 'Google Docs' is the person's whole
// Drive (shown as Google Drive), so its logo is Drive's (ConnectLibrary.jsx LOGOS, 2026-10-10).

public enum Logos {
    /// A catalog tool's logo file (logos.js TOOL_LOGOS), by app id. Claude Code shares Claude's.
    public static let toolFiles: [String: String] = [
        "Obsidian": "obsidian", "Notion": "notion", "Apple Notes": "apple", "OneNote": "microsoft-onenote", "Google Docs": "google-drive", "Evernote": "evernote",
        "Granola": "granola-light", "Google Meet": "google-meet", "Zoom": "zoom", "Gmail": "gmail",
        "ChatGPT": "openai", "Codex": "codex_light", "Claude": "claude-ai-icon", "Claude Code": "claude-ai-icon", "Grok": "grok-light", "Gemini": "gemini",
        "Perplexity": "perplexity", "Cursor": "cursor_light", "Zotero": "zotero", "Overleaf": "overleaf", "GitHub": "github", "Linear": "linear",
    ]
    /// The intro's row of logos (the mockup's WORKS): Google Docs here is the Docs logo, shown as Google Drive.
    public static let works: [(app: String, file: String)] = [("Zotero", "zotero"), ("Overleaf", "overleaf"), ("Obsidian", "obsidian"), ("Google Docs", "googledocs"),
                                                             ("ChatGPT", "openai"), ("Claude", "claude-ai-icon"), ("Codex", "codex_light"), ("GitHub", "github")]
    /// The browsers' icons (BROWSER_LOGOS).
    public static let browserIds = ["safari", "chrome", "brave", "firefox", "arc", "edge", "opera", "chromium", "comet"]
    /// PROVIDER_LOGOS: anthropic = Claude's, openai = Codex's.
    public static let providerFiles = ["anthropic": "claude-ai-icon", "openai": "codex_light"]

    static var bundle: Bundle { ResourceBundle.named("ImportUI_EngelbartImportUI", fallback: Bundle.module) }

    private static var cache: [String: NSImage] = [:]
    private static let lock = NSLock()

    /// An image in Resources/logos (`file` without extension; `browsers/chrome` for a browser).
    public static func image(file: String) -> NSImage? {
        lock.lock(); defer { lock.unlock() }
        if let hit = cache[file] { return hit }
        for ext in ["svg", "png"] {
            let url = bundle.url(forResource: file, withExtension: ext, subdirectory: "Resources/logos")
                ?? bundle.resourceURL.map { $0.appendingPathComponent("Resources/logos/\(file).\(ext)") }
            if let url, FileManager.default.fileExists(atPath: url.path), let image = NSImage(contentsOf: url) {
                cache[file] = image
                return image
            }
        }
        return nil
    }

    /// The logo file of an app id, or nil (a folder, the browser history, a tool the agents found).
    public static func toolFile(_ app: String) -> String? { toolFiles[app] }
    public static func tool(_ app: String) -> NSImage? { toolFile(app).flatMap { image(file: $0) } }
    public static func browser(_ id: String) -> NSImage? { browserIds.contains(id) ? image(file: "browsers/\(id)") : nil }
    public static func provider(_ id: String) -> NSImage? { providerFiles[id].flatMap { image(file: $0) } }
}

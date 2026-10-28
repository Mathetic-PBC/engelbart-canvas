import Foundation
import EngelbartCore

/// What a Build agent may reach beyond its worktree (policy.cjs, 2026-09-25 B9; widened 2026-10-07 "Bart build agents",
/// B30). Read and write outside the worktree; the project's Engelbart folder and <data root>/assets are added to the
/// folders it works in; papers never lost (Keep.swift) and the edit tools refused on them, on the saved copies and on
/// Engelbart's records; Engelbart's own MCP tools; the person's own setup; subagents; git is Engelbart's (GitGuard);
/// computer use and browser control none; network as each CLI allows by default.
public struct BuildPolicy: Sendable, Equatable {
    /// Worked in besides the worktree (Claude Code --add-dir).
    public var folders: [String]
    /// Codex's sandbox writes there without asking.
    public var writable: [String]
    /// Saved copies: papers, pages, pictures.
    public var kept: [String]
    public var records: [String]
    public var papers: [String]
    public var gitDir: String?
    public var personal = true
    public var subagents = true
    public var computerUse = false

    // The person's MCP servers that would hand the agent the screen.
    public static let computerUseServers = ["computer-use"]
    static let editTools = ["Edit", "Write", "NotebookEdit"]
    static let maxPaperRules = 2000

    /// `papers`: the pdfs and pictures the library holds outside `kept`; `gitDir`: the Build repository's git folder.
    public static func make(projectDir: String?, dataRoot: String?, papers: [String] = [], gitDir: String? = nil) -> BuildPolicy {
        func unique(_ list: [String?]) -> [String] {
            var seen = Set<String>(); var out: [String] = []
            for item in list { if let item, !item.isEmpty, seen.insert(item).inserted { out.append(item) } }
            return out
        }
        let assets = dataRoot.map { NodePath.join($0, "assets") }
        let dir = projectDir
        // The Swift app's databases are SQLite files (ARCHITECTURE §3); the PGlite names are kept for a root the
        // Electron app shares.
        let projectRecords = ["builds", "notes.pglite", "notes.sqlite", ".context", ".legacy", "project.json", "**/meta.json"]
        let rootRecords = ["library.pglite", "library.sqlite", "config.json", "state.json", "github.json", "zotero.json"]
        return BuildPolicy(
            folders: unique([dir, assets]),
            writable: unique([dir]),
            kept: unique([assets, dir.map { NodePath.join($0, "assets") }]),
            records: unique((dir.map { d in projectRecords.map { NodePath.join(d, $0) } } ?? []) + (dataRoot.map { r in rootRecords.map { NodePath.join(r, $0) } } ?? [])),
            papers: Array(unique(papers).prefix(maxPaperRules)),
            gitDir: gitDir)
    }

    /// Claude Code's --settings for a policy, on top of the person's own: Engelbart's tools allowed; the edit tools
    /// refused on saved copies, papers and Engelbart's records; the computer-use server refused.
    public func claudeSettings() -> JSONValue {
        var deny: [String] = []
        let rule = { (target: String) in "/\(target)" } // an absolute path is written //… (a single / is the settings file's folder)
        for dir in kept { for tool in BuildPolicy.editTools { deny.append("\(tool)(\(rule(dir))/**)") } }
        for record in records {
            let folder = !(record.hasSuffix(".json") || record.hasSuffix(".sqlite")) // a PGlite database is a folder; SQLite a file
            for tool in BuildPolicy.editTools { deny.append("\(tool)(\(rule(record))\(folder ? "/**" : ""))") }
        }
        for file in papers { for tool in BuildPolicy.editTools { deny.append("\(tool)(\(rule(file)))") } }
        if !computerUse { for server in BuildPolicy.computerUseServers { deny.append("mcp__\(server)") } }
        return ["permissions": ["allow": ["mcp__engelbart"], "deny": .array(deny.map(JSONValue.string))]]
    }
}

import Foundation
import EngelbartCore

// Port of src/shared/connect-sources.cjs (Connect your library, 2026-10-07; Claude Design "Connect Library.dc.html", the
// "Onboarding brainstorm" note): the kinds of thing the person can bring into their library and the apps each comes from.
//
// `reach` says how the agents get at an app. Since the second build ("Agent onboarding", 2026-10-07: "Instead of telling
// me to do stuff, it must use computer use to do all this stuff for me!") the person is never told to export, download
// or choose a file for an app that lives on the web; the agents do it:
//   local       files on this Mac. `pick` ('folder') is what a button chooses when they are not where the app keeps them
//   web         the agents' own browser, hidden, on the sign-ins of Engelbart's Stage. `sites` are the only hosts it
//               opens for the app (sign-in pages: signInSites), `start` where it begins
//   connector   the app's official MCP server, signed in with OAuth (Connectors.swift); `mcp` its address, `scope` the
//               OAuth scope asked for, `also` the server's other addresses (a person's own Claude Code or Codex may name
//               one: OwnConnectors.swift), `reads` the server's tools that only read ({ list, read }), `fallback` ('web')
//               the route used while the server can't be
//   signin      Engelbart's own sign-in (Zotero, GitHub)
//   automation  macOS Automation: Engelbart asks the app itself (Apple Notes)
// `memory`: an AI assistant that keeps memories of the person (RECALL_PROMPT, which goes into MEMORY.md).

public enum Reach: String, Sendable, Codable { case local, web, connector, signin, automation }

public struct ConnectorReads: Sendable, Equatable {
    public var list: [String]
    public var read: [String]
}

public struct AppInfo: Sendable, Equatable {
    public var reach: Reach
    public var pick: String? = nil
    public var mcp: String? = nil
    public var scope: String? = nil
    public var also: [String] = []
    public var sites: [String] = []
    public var start: String? = nil
    public var reads: ConnectorReads? = nil
    public var fallback: String? = nil
    public var memory: Bool = false
}

public struct SourceGroup: Sendable, Equatable {
    public var id: String
    public var label: String
    public var apps: [String]
}

public enum ConnectSources {
    /// LOCAL_PDFS (2026-10-08, "Agent onboarding"): the PDFs in the person's own folders, looked through by folder.
    public static let localPDFs = "PDFs on this Mac"

    public static let sources: [SourceGroup] = [
        SourceGroup(id: "notes", label: "Notes", apps: ["Obsidian", "Notion", "Apple Notes", "OneNote", "Google Docs", "Evernote"]),
        SourceGroup(id: "transcripts", label: "Meeting transcripts", apps: ["Granola", "Google Meet", "Zoom"]),
        SourceGroup(id: "email", label: "Email", apps: ["Gmail"]),
        SourceGroup(id: "chats", label: "AI chats", apps: ["ChatGPT", "Codex", "Claude", "Claude Code", "Grok", "Gemini", "Perplexity", "Cursor"]),
        SourceGroup(id: "sites", label: "Websites", apps: []),
        SourceGroup(id: "papers", label: "Papers", apps: ["Zotero", "Overleaf", localPDFs]),
        SourceGroup(id: "code", label: "Code", apps: []),
        // Other (2026-10-16, Hudson's Onboarding note: "Don't add that new projects category, just Linear should by
        // default be in the 'Other' category").
        SourceGroup(id: "other", label: "Other", apps: ["Linear"]),
    ]

    public static let google = ["drive.google.com", "docs.google.com", "accounts.google.com", "myaccount.google.com", "www.google.com", "google.com"]

    /// Insertion order of the Electron object (used where the code iterates `Object.keys(APPS)`).
    public static let appOrder = ["Obsidian", "Notion", "Apple Notes", "OneNote", "Google Docs", "Evernote", "Granola", "Google Meet", "Zoom",
                                  "Gmail", "ChatGPT", "Codex", "Claude", "Claude Code", "Grok", "Gemini", "Perplexity", "Cursor", "Zotero",
                                  "Overleaf", localPDFs, "GitHub", "Linear"]

    public static let apps: [String: AppInfo] = [
        "Obsidian": AppInfo(reach: .local, pick: "folder"),
        "Notion": AppInfo(reach: .connector, mcp: "https://mcp.notion.com/mcp", sites: ["notion.so", "notion.com"], start: "https://www.notion.so/"),
        "Apple Notes": AppInfo(reach: .automation),
        "OneNote": AppInfo(reach: .web, sites: ["onenote.com", "onenote.cloud.microsoft", "office.com", "live.com", "microsoft.com", "microsoftonline.com", "sharepoint.com"], start: "https://www.onenote.com/notebooks"),
        "Google Docs": AppInfo(reach: .web, sites: google, start: "https://drive.google.com/drive/recent"),
        // Evernote (2026-10-16): its official MCP server (beta); only `read` is asked for; the browser stays its fallback.
        "Evernote": AppInfo(reach: .connector, mcp: "https://mcp.evernote.com/mcp", scope: "read", sites: ["evernote.com"], start: "https://www.evernote.com/client/web",
                            reads: ConnectorReads(list: ["search_notebooks", "search_notes", "semantic_search", "search_tags", "search_spaces"], read: ["get_note", "get_attachment", "get_space"]),
                            fallback: "web"),
        "Granola": AppInfo(reach: .connector, mcp: "https://mcp.granola.ai/mcp"),
        "Google Meet": AppInfo(reach: .web, sites: google + ["meet.google.com"], start: "https://drive.google.com/drive/search?q=type:document%20Meet%20Recordings"),
        "Zoom": AppInfo(reach: .local, pick: "folder", sites: ["zoom.us"]),
        // Gmail (2026-10-11): the same Google sign-in as Google Docs. Never brought in whole (tools gmail_*).
        "Gmail": AppInfo(reach: .web, sites: google + ["mail.google.com"], start: "https://mail.google.com/mail/"),
        "ChatGPT": AppInfo(reach: .web, sites: ["chatgpt.com", "chat.openai.com", "openai.com"], start: "https://chatgpt.com/", memory: true),
        "Codex": AppInfo(reach: .local),
        "Claude": AppInfo(reach: .web, sites: ["claude.ai", "claude.com", "anthropic.com"], start: "https://claude.ai/recents", memory: true),
        "Claude Code": AppInfo(reach: .local),
        "Grok": AppInfo(reach: .web, sites: ["grok.com", "x.ai", "x.com"], start: "https://grok.com/", memory: true),
        "Gemini": AppInfo(reach: .web, sites: ["gemini.google.com"] + google, start: "https://gemini.google.com/app", memory: true),
        "Perplexity": AppInfo(reach: .web, sites: ["perplexity.ai"], start: "https://www.perplexity.ai/library"),
        "Cursor": AppInfo(reach: .local),
        "Zotero": AppInfo(reach: .signin),
        "Overleaf": AppInfo(reach: .web, sites: ["overleaf.com"], start: "https://www.overleaf.com/project"),
        localPDFs: AppInfo(reach: .local, pick: "folder"),
        "GitHub": AppInfo(reach: .signin),
        // Linear (2026-10-16): its official MCP server's read-only endpoint; `also` the read-write and old SSE ones.
        "Linear": AppInfo(reach: .connector, mcp: "https://mcp.linear.app/mcp/readonly", scope: "read",
                          also: ["https://mcp.linear.app/mcp", "https://mcp.linear.app/sse"], sites: ["linear.app"], start: "https://linear.app/",
                          reads: ConnectorReads(list: ["list_teams", "list_projects", "list_issues", "list_documents", "list_cycles", "get_user"],
                                                read: ["get_project", "get_issue", "get_document", "list_comments", "list_milestones", "get_milestone", "get_status_updates", "get_team", "list_issue_statuses", "list_issue_labels", "list_project_labels"])),
    ]

    /// Where a sign-in may take a page on its way back to an app.
    public static let signInSites = ["accounts.google.com", "appleid.apple.com", "idmsa.apple.com", "login.microsoftonline.com", "login.live.com",
                                     "auth.openai.com", "auth0.openai.com", "accounts.x.ai", "github.com", "okta.com", "auth0.com"]

    public struct SignInCookie: Sendable {
        public var domain: String
        /// The JS regex source (`signInGroup` keys on it).
        public var source: String
        public func matches(_ name: String) -> Bool { name.range(of: source, options: .regularExpression) != nil }
    }

    /// The cookie that holds each web app's sign-in. Apps with the same entry share one sign-in.
    public static let signInCookieOrder = ["ChatGPT", "Claude", "Google Docs", "Google Meet", "Gmail", "Gemini", "Overleaf", "Perplexity", "Grok", "Notion"]
    public static let signInCookies: [String: SignInCookie] = [
        "ChatGPT": SignInCookie(domain: "chatgpt.com", source: "session-token"),
        "Claude": SignInCookie(domain: "claude.ai", source: "^sessionKey$"),
        "Google Docs": SignInCookie(domain: "google.com", source: "^(__Secure-1PSID|SID)$"),
        "Google Meet": SignInCookie(domain: "google.com", source: "^(__Secure-1PSID|SID)$"),
        "Gmail": SignInCookie(domain: "google.com", source: "^(__Secure-1PSID|SID)$"),
        "Gemini": SignInCookie(domain: "google.com", source: "^(__Secure-1PSID|SID)$"),
        "Overleaf": SignInCookie(domain: "overleaf.com", source: "^overleaf_session"),
        "Perplexity": SignInCookie(domain: "perplexity.ai", source: "session-token"),
        "Grok": SignInCookie(domain: "grok.com", source: "^sso$"),
        "Notion": SignInCookie(domain: "notion.so", source: "^token_v2$"),
    ]

    /// The sign-in an app shares with others ('google.com SID…' for Gmail and Google Drive alike); an app with none, its own name.
    public static func signInGroup(_ app: String) -> String {
        guard let entry = signInCookies[app] else { return app }
        return "\(entry.domain) \(entry.source)"
    }

    /// The apps signed in by the one sign-in `app` makes, itself first.
    public static func sharesSignIn(_ app: String) -> [String] {
        [app] + signInCookieOrder.filter { $0 != app && signInGroup($0) == signInGroup(app) }
    }

    /// Google's sign-in group (Drive, Gmail, Meet, Gemini) signs in through the person's own browser (2026-10-12).
    public static func signsInThroughBrowser(_ app: String) -> Bool {
        signInCookies[app] != nil && signInGroup(app) == signInGroup("Gmail")
    }

    /// 'Google Docs' opens the whole Drive, so it is shown as Google Drive (2026-10-10). Ids stay keys everywhere.
    public static let shownNames = ["Google Docs": "Google Drive"]
    public static func shownName(_ app: String) -> String { shownNames[app] ?? app }

    public static var sourceIds: [String] { sources.map(\.id) }
    public static func sourceOf(_ id: String) -> SourceGroup? { sources.first { $0.id == id } }
    public static func appOf(_ name: String) -> AppInfo? { apps[name] }
    /// The source an app is listed under ('notes' for Obsidian), or nil. GitHub is Code's.
    public static func sourceOfApp(_ name: String) -> String? {
        if name == "GitHub" { return "code" }
        return sources.first { $0.apps.contains(name) }?.id
    }

    /// What a library row knows about where it came from (Library Phase B, 2026-10-11).
    public static let itemSources: [String] = {
        var out: [String] = []
        for app in sources.flatMap(\.apps) + appOrder.filter({ $0 != "GitHub" }) where !out.contains(app) { out.append(app) }
        return out + ["engelbart", "mac", "web", "github", "create"]
    }()
    public static let itemCategories = ["chat", "meeting", "email", "note", "paper", "repo", "web", "data", "document", "image", "file"]
    public static let groupCategories = ["transcripts": "meeting", "chats": "chat", "email": "email", "notes": "note", "papers": "paper"]
    /// The category an import from `app` gets unless it knows better: its group's ('chat' for Claude), else nil.
    public static func categoryOfApp(_ app: String) -> String? { sourceOfApp(app).flatMap { groupCategories[$0] } }
    /// The chat apps, whose kept chats begin with a `*<App> · <date> · <project>*` line.
    public static var chatApps: [String] { sourceOf("chats")?.apps ?? [] }
    public static func recallApps(_ apps: [String]) -> [String] { apps.filter { appOf($0)?.memory == true } }
    public static func fallbackOf(_ app: String) -> String? { appOf(app)?.fallback }
    public static func webApps(_ apps: [String]) -> [String] { apps.filter { appOf($0)?.reach == .web } }

    /// The browsers a web app's sign-in is brought over from, as the person is told when they have none of them.
    public static let readableNames = "Chrome, Brave or Firefox"

    public struct Period: Sendable { public var days: Int?; public var label: String }
    /// How far back an import looks (2026-10-10). nil: all time.
    public static let periods = [Period(days: 182, label: "the past 6 months"), Period(days: 365, label: "the past year"), Period(days: nil, label: "all time")]
    public static let defaultPeriodDays = 365
    /// 182 or 365 as they are; anything else is all time (nil).
    public static func cleanDays(_ value: Int?) -> Int? { value == 182 || value == 365 ? value : nil }
    public static func cleanDays(_ value: JSONValue?) -> Int? { value?.double.flatMap { $0 == 182 || $0 == 365 ? Int($0) : nil } }
    public static func periodName(_ days: Int?) -> String { (periods.first { $0.days == cleanDays(days) } ?? periods[2]).label }
}

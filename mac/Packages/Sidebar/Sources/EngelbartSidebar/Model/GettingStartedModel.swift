import Foundation
import EngelbartDoc
import EngelbartStore

// The Welcome walkthrough (2026-10-09; src/renderer/model/getting-started.js): under the title of a new user's "Welcome"
// project, "Get started": see what came in (the Library's tabs), @brainstorm, @discover (and the papers it found).
// GettingStartedView draws it; its state is the Store's (gettingStarted / setGettingStarted). Pure.

public struct WalkStep: Equatable, Sendable {
    public var n: Int
    public var title: String
    public var hint: String
    public var shown: Int
}

/// The Store's walkthrough state: the Welcome project's id, the steps ticked, hidden for good.
public struct WalkState: Equatable, Sendable {
    public var workspaceId: String?
    public var ticked: [Int]
    public var hidden: Bool
    public init(workspaceId: String?, ticked: [Int] = [], hidden: Bool = false) { self.workspaceId = workspaceId; self.ticked = ticked; self.hidden = hidden }
}

public struct LibraryTab: Equatable, Sendable { public var id: String; public var label: String; public var count: Int }

public struct DiscoverPaper: Equatable, Sendable {
    public var key: String
    public var title: String
    public var why: String
    public var address: String
    public var byline: String
}

public enum GettingStartedModel {
    public static let STEPS: [WalkStep] = [
        WalkStep(n: 1, title: "See what came in", hint: "Everything Connect brought in is in Library, in the sidebar, under these tabs.", shown: 1),
        WalkStep(n: 2, title: "Brainstorm what to do next", hint: "Type @brainstorm in this project and press Enter.", shown: 2),
        WalkStep(n: 3, title: "Find prior work", hint: "When the brainstorm ends, press @discover under the result. The papers it finds show here.", shown: 3),
    ]

    /// The hint on an empty last line of a document while the walkthrough shows.
    public static let EMPTY_HINT = "Write your thoughts…"

    static func ticksOf(_ ticked: [Int]) -> [Int] { Array(Set(ticked.filter { $0 >= 1 && $0 <= STEPS.count })).sorted() }

    /// The steps a project shows: all three in the Welcome project, none elsewhere or once hidden.
    public static func stepsHere(_ state: WalkState?, _ workspaceId: String?) -> [WalkStep] {
        guard let state, !state.hidden, let workspaceId, workspaceId == state.workspaceId else { return [] }
        return STEPS
    }

    /// The first of `steps` not ticked (its n), or nil when all are.
    public static func firstOpen(_ steps: [WalkStep], _ ticked: [Int]) -> Int? {
        let done = Set(ticksOf(ticked))
        return steps.first { !done.contains($0.n) }?.n
    }

    static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }

    /// Step 1's rows: the Library panel's tabs that hold something, with their counts, and the total under All.
    public static func libraryTabs(_ rows: [LibraryRow]) -> (tabs: [LibraryTab], total: Int) {
        let counts = Kind.libraryCounts(rows.map(\.lib))
        let tabs = Kind.LIBRARY_CHIPS.filter { $0.id != "all" && (counts[$0.id] ?? 0) > 0 }.map { LibraryTab(id: $0.id, label: $0.label, count: counts[$0.id] ?? 0) }
        return (tabs, counts["all"] ?? 0)
    }

    static let GUIDE_TITLE = Rx(#"^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)\*\*\s*(?:·\s*(.*))?$"#)
    static let GUIDE_READ = Rx(#"^\*\*Read:\*\*\s*\[([^\]\n]+)\]\(([^)\s]+)\)"#)
    static let GUIDE_WHY = Rx(#"^\*\*Why:\*\*\s*(.+)$"#)

    /// Step 3's papers: the ones @discover's guides in a document found, in order, each once, at most `max`.
    public static func discoverPapers(_ text: String?, max: Int = 3) -> [DiscoverPaper] {
        struct Entry { var key, title, by, section, why, address: String }
        var out: [Entry] = []
        var seen = Set<String>()
        var at: Int? = nil
        for raw in (text ?? "").components(separatedBy: "\n") {
            guard let reply = DocRx.REPLY.match(raw) else { at = nil; continue }
            let line = (reply[2] ?? "").trimmed
            if let title = GUIDE_TITLE.match(line) {
                at = nil
                let address = Rx(#"#.*$"#).replace(title[2] ?? "", with: "")
                if seen.contains(address) || out.count >= max { continue }
                seen.insert(address)
                let by = Rx(#"\s+et al\.?"#, "i").replace(title[3] ?? "", with: "").trimmed
                out.append(Entry(key: address, title: (title[1] ?? "").trimmed, by: by, section: "", why: "", address: title[2] ?? ""))
                at = out.count - 1
                continue
            }
            guard let i = at else { continue }
            if let read = GUIDE_READ.match(line), out[i].section.isEmpty { out[i].section = (read[1] ?? "").trimmed; out[i].address = read[2] ?? ""; continue }
            if let why = GUIDE_WHY.match(line), out[i].why.isEmpty { out[i].why = (why[1] ?? "").trimmed }
        }
        return out.map { DiscoverPaper(key: $0.key, title: $0.title, why: $0.why, address: $0.address, byline: [$0.by, $0.section].filter { !$0.isEmpty }.joined(separator: " · ")) }
    }

    /// What sits at the right of a step's row: how much is under it, or where it leads.
    public static func stepMeta(_ n: Int, items: Int = 0, papers: Int = 0) -> String {
        if n == 1 { return items > 0 ? plural(items, "item") : "Library" }
        if n == 3 { return papers > 0 ? plural(papers, "paper") : "" }
        return ""
    }
}

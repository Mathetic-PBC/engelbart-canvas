import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartUI
import Foundation
import SwiftUI

// All projects (Claude Design "Projects.dc.html", 2026-09-21; port of src/renderer/screens/Home.jsx): the library as a
// rail on the left — one list sorted by kind, a search field, Add context — and the projects beside it as cards that size
// to their content: name, the kinds of library items the project holds, and its most recently edited workspaces as page
// tiles. A card opens the project; a tile opens that workspace. Hovering a library row or a tile for a beat opens a peek
// you can move onto and scroll. A card's can (on hover) deletes the project, after asking: into the trash for a week
// (2026-10-03). Recently deleted, under the cards, lists what is in the trash, with Restore.

/// The pure part of Home.jsx: what the rail lists and finds, what a card says, where a peek goes.
public enum HomeLogic {
    public static let MAX_ICONS = 5
    public static let OPEN_DELAY: TimeInterval = 0.35
    public static let SWITCH_DELAY: TimeInterval = 0.09
    public static let CLOSE_DELAY: TimeInterval = 0.18
    public static let PEEK_GAP: CGFloat = 8

    /// The rail's rows: a picture pasted into a document is that project's attachment, not shown here; one added to the
    /// library is (MATH-19). By kind (note, md, docx, pdf, git, folder, website, html, data, then unknown), newest first.
    public static func rows(_ library: [LibraryRow]) -> [LibraryRow] {
        library.filter { !($0.type == "image" && $0.projectId != nil) }
            .enumerated()
            .sorted { a, b in
                let ra = Kind.kindRank(a.element.lib), rb = Kind.kindRank(b.element.lib)
                if ra != rb { return ra < rb }
                if a.element.lastEdited != b.element.lastEdited { return a.element.lastEdited > b.element.lastEdited }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    /// The row's kind label (kindOf(row).label): its type then its tags ("pdf · paper"), "link" for a website.
    public static func kindLabel(_ row: LibraryRow) -> String {
        let key = Kind.kindKey(row.lib)
        return KindIcons.kind(key, label: row.type.isEmpty ? nil : Kind.kindLabel(row.lib)).label
    }

    /// What the search finds (2026-10-08 the bodies too): the needle trimmed and lower-cased, in the row's name, address,
    /// kind and summary, or in what its pdf or note says (`bodies`, lower-cased, by id).
    public static func matches(_ rows: [LibraryRow], query: String, bodies: [String: String]?) -> [LibraryRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if needle.isEmpty { return rows }
        return rows.filter { row in
            if "\(row.name) \(row.url ?? "") \(kindLabel(row)) \(row.summary ?? "")".lowercased().contains(needle) { return true }
            if let text = bodies?[row.id], !text.isEmpty, text.contains(needle) { return true }
            return false
        }
    }

    /// The rows of projects in the trash are in the trash with them: no screen lists them until it is restored (App.jsx).
    public static func shownLibrary(_ library: [LibraryRow], trashed: [TrashedProject]) -> [LibraryRow] {
        let gone = Set(trashed.map(\.id))
        return gone.isEmpty ? library : library.filter { !gone.contains($0.projectId ?? "") }
    }

    /// "just now", "N min ago", "N h ago", "yesterday", "N days ago"; "" without a date.
    public static func relative(_ iso: String?, now: Date = Date()) -> String {
        guard let iso, let date = parseISO(iso) else { return "" }
        let ms = now.timeIntervalSince(date) * 1000
        let minutes = jsRound(ms / 60000)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(Int(minutes)) min ago" }
        let hours = jsRound(minutes / 60)
        if hours < 24 { return "\(Int(hours)) h ago" }
        let days = jsRound(hours / 24)
        return days == 1 ? "yesterday" : "\(Int(days)) days ago"
    }

    /// The day a project in the trash is purged: "Oct 10".
    public static func day(_ iso: String?, locale: Locale = .current) -> String {
        guard let iso, let date = parseISO(iso) else { return "" }
        let format = DateFormatter()
        format.locale = locale
        format.setLocalizedDateFormatFromTemplate("MMMd")
        return format.string(from: date)
    }

    /// Math.round: halves go up.
    static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    static func parseISO(_ iso: String) -> Date? {
        let withMs = ISO8601DateFormatter()
        withMs.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withMs.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Under a card's name: "3 projects · edited 2 h ago" (what were workspaces are projects, 2026-10-13).
    public static func cardMeta(workspaceCount: Int, lastEdited: String?, now: Date = Date()) -> String {
        let when = relative(lastEdited, now: now)
        return "\(workspaceCount) project\(workspaceCount == 1 ? "" : "s")" + (lastEdited != nil && !(lastEdited ?? "").isEmpty ? " · edited \(when)" : "")
    }

    /// The kinds a project holds, once each, in the rail's order, at most five; then what they stand for:
    /// "+ N more" (the rows the glyphs leave out) or "N from the library".
    public struct Held: Equatable, Sendable { public var kinds: [String]; public var caption: String }
    public static func heldIcons(_ rows: [LibraryRow]) -> Held? {
        if rows.isEmpty { return nil }
        let keys = Set(rows.map { Kind.kindKey($0.lib) })
        let kinds = Array(Kind.KIND_ORDER.filter { keys.contains($0) }.prefix(MAX_ICONS))
        let rest = rows.count - kinds.count
        return Held(kinds: kinds, caption: rest > 0 ? "+ \(rest) more" : "\(rows.count) from the library")
    }

    /// Two workspace tiles a card, three and four as the projects column gets room for them.
    public static func tiles(columnWidth width: CGFloat) -> Int { width >= 1500 ? 4 : width >= 1000 ? 3 : 2 }

    /// Where a peek goes, in the screen's coordinates (y down): beside the row (right when it fits), its top near the
    /// row's, its height capped by the window. `onRight`: the wrapper's padding (the gap that still counts as hovering)
    /// is on its left.
    public struct PeekFrame: Equatable, Sendable { public var left: CGFloat; public var top: CGFloat; public var width: CGFloat; public var maxHeight: CGFloat; public var onRight: Bool }
    public static func peekFrame(row: CGRect, workspace: Bool, window: CGSize) -> PeekFrame {
        let width: CGFloat = workspace ? 420 : 380
        let left = row.maxX + PEEK_GAP + width <= window.width - 8 ? row.maxX : max(8, row.minX - width - PEEK_GAP)
        let top = max(54, min(row.minY - 12, window.height - 380))
        let maxHeight = min(workspace ? 520 : 440, window.height - top - 12)
        return PeekFrame(left: left, top: top, width: width, maxHeight: maxHeight, onRight: left == row.maxX)
    }

    /// The workspace peek's top line: "<project> / <its parents>" when its path is not its name; else the project.
    public static func workspaceTrail(project: String, path: String, name: String) -> String {
        guard path != name else { return project }
        let parents = path.split(separator: "/", omittingEmptySubsequences: false).dropLast().map(String.init)
        return "\(project) / \(parents.joined(separator: " / "))"
    }

    /// A url without its scheme, "www." and trailing slash; else a path's file name.
    public static func source(_ row: LibraryRow) -> String {
        if let url = row.url, !url.isEmpty {
            var s = url.replacingOccurrences(of: "^https?://(www\\.)?", with: "", options: .regularExpression)
            if s.hasSuffix("/") { s.removeLast() }
            return s
        }
        if let path = row.path, !path.isEmpty { return path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path }
        return ""
    }
}

/// What the app hands the all-projects screen (Home.jsx props): its data, and what the screen asks the app to do.
public struct HomeContext {
    public var data: HomeData
    /// "+ Project": the create screen (App.jsx setPhase('create')).
    public var onCreateScreen: () -> Void
    /// A card (workspace nil: where it was left), a tile, a holder in a peek; `stage`: a library row to show on its Stage.
    public var onOpenWorkspace: (_ projectId: String, _ workspaceId: String?, _ stage: LibraryRow?) -> Void
    /// A note row: opened in its project, in the workspace it was made in.
    public var onOpenNote: (LibraryRow) -> Void
    /// A row no project holds: on the Stage of the project last open (else the first).
    public var onOpenOnStage: (LibraryRow) -> Void
    public var onRename: (_ projectId: String, _ name: String) -> Void
    /// Into the trash for a week; nil hides the cards' cans.
    public var onDelete: ((String) async -> Void)?
    public var onRestore: (String) async -> Void
    /// The library and the projects read again (App.jsx loadHome).
    public var onLibraryChanged: () async -> Void
    /// The sidebar's Add context (workspace/Rail.jsx AddToLibrary, 2026-09-28), from the Sidebar package; nil = the
    /// stand-in here (a link or path field and Choose from disk…).
    public var addToLibrary: ((HomeAddHandlers) -> AnyView)?

    public init(data: HomeData, onCreateScreen: @escaping () -> Void, onOpenWorkspace: @escaping (String, String?, LibraryRow?) -> Void,
                onOpenNote: @escaping (LibraryRow) -> Void, onOpenOnStage: @escaping (LibraryRow) -> Void,
                onRename: @escaping (String, String) -> Void, onDelete: ((String) async -> Void)?, onRestore: @escaping (String) async -> Void,
                onLibraryChanged: @escaping () async -> Void, addToLibrary: ((HomeAddHandlers) -> AnyView)? = nil) {
        self.data = data; self.onCreateScreen = onCreateScreen; self.onOpenWorkspace = onOpenWorkspace; self.onOpenNote = onOpenNote
        self.onOpenOnStage = onOpenOnStage; self.onRename = onRename; self.onDelete = onDelete; self.onRestore = onRestore
        self.onLibraryChanged = onLibraryChanged; self.addToLibrary = addToLibrary
    }
}

/// What Home gives the sidebar's AddToLibrary (Rail.jsx props).
public struct HomeAddHandlers {
    /// A link or a path: added; what could not be added is thrown back ("a · b").
    public var onAdd: (String) async throws -> Void
    /// Choose from disk…: each file picked its own row.
    public var onPickDisk: () async -> Void
    /// A repository from GitHub: the row that holds it opens, else its address is added.
    public var onPickRepo: (_ repoUrl: String, _ row: LibraryRow?) async throws -> Void
    /// A search result: an item the library holds opens; a fresh one (the typed text) is added.
    public var onSearchPick: (_ result: SearchPick) async throws -> Void
    public var library: [LibraryRow]
    /// Home has no rail of its own: nothing is "in this rail".
    public var inRail: (String) -> Bool
}

public enum SearchPick { case item(LibraryRow), fresh(String) }

/// One peek: a library row's or a workspace tile's, and the rect it hangs from (the screen's coordinates, y down).
public struct HomePeek: Equatable {
    public enum Kind: Equatable { case item(LibraryRow), workspace(RecentWorkspace, project: PublicProject) }
    public var key: String
    public var kind: Kind
    public var rect: CGRect
    public var isWorkspace: Bool { if case .workspace = kind { return true }; return false }
}

/// Home.jsx's state and handlers. The view draws it; tests drive it.
@MainActor
public final class HomeModel: ObservableObject {
    @Published public var projects: [PublicProject] = []
    @Published public var trashed: [TrashedProject] = []
    @Published public var library: [LibraryRow] = [] { didSet { rows = HomeLogic.rows(library) } }
    @Published public var error = ""
    @Published public private(set) var rows: [LibraryRow] = []

    @Published public var query = "" { didSet { if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != oldValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { syncBodies() } } }
    @Published public var renaming: String?
    @Published public var deleting: PublicProject?
    @Published public var deleteBusy = false
    @Published public var restoring: String?
    @Published public var addError = ""
    @Published public private(set) var addBusy = false
    @Published public var dropping = false
    @Published public private(set) var justAdded: String?
    @Published public private(set) var peek: HomePeek?
    @Published public private(set) var previews: [String: Library.Preview?] = [:]
    @Published public private(set) var bodies: [String: String]?
    @Published public var tiles = 2

    public var context: HomeContext
    /// The beats (350 / 90 / 180 ms); tests shorten them.
    public var delays = (open: HomeLogic.OPEN_DELAY, switching: HomeLogic.SWITCH_DELAY, close: HomeLogic.CLOSE_DELAY)
    /// How long a row just added flashes.
    public var flashTime: TimeInterval = 1.6
    private var timer: DispatchWorkItem?
    private var flashTimer: DispatchWorkItem?
    private var bodiesAsk = 0

    public init(context: HomeContext) { self.context = context }

    /// The app's data for the screen (Home.jsx's props), whenever it changes.
    public func update(projects: [PublicProject], trashed: [TrashedProject], library: [LibraryRow], error: String) {
        self.projects = projects; self.trashed = trashed; self.library = library; self.error = error
        if let peek, case .item(let row) = peek.kind, !library.contains(where: { $0.id == row.id }) { self.peek = nil }
    }

    public var shown: [LibraryRow] { HomeLogic.matches(rows, query: query, bodies: bodies) }
    public var byId: [String: LibraryRow] { Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }

    /// The rows a card's project holds, in its order.
    public func held(_ project: PublicProject) -> [LibraryRow] {
        let index = byId
        return (project.libraryIds ?? []).compactMap { index[$0] }
    }

    // MARK: - search

    /// What the library's pdfs and notes say (2026-10-08), asked for while something is typed, let go when cleared.
    private func syncBodies() {
        bodiesAsk += 1
        let ask = bodiesAsk
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { bodies = nil; return }
        let data = context.data
        Task { @MainActor in
            guard let reply = try? await data.libraryBodies() else { return }
            guard ask == self.bodiesAsk else { return }
            self.bodies = reply.mapValues { $0.lowercased() }
        }
    }

    /// Escape in the search: clears it when it holds something (and is used); empty, it passes on.
    @discardableResult public func escapeSearch() -> Bool {
        guard !query.isEmpty else { return false }
        query = ""
        return true
    }

    // MARK: - peek

    /// Opens after a beat, stays while the pointer is on the row, the gap or the peek, and closes a moment after it has
    /// left all three.
    public func hold() { timer?.cancel(); timer = nil }

    public func openPeek(_ next: HomePeek) {
        hold()
        if peek?.key == next.key { return }
        let work = DispatchWorkItem { [weak self] in self?.peek = next }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (peek != nil ? delays.switching : delays.open), execute: work)
    }

    public func closePeek() {
        hold()
        let work = DispatchWorkItem { [weak self] in self?.peek = nil }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delays.close, execute: work)
    }

    /// The list scrolled, a card or tile was pressed: the peek goes at once.
    public func dropPeek() { hold(); peek = nil }

    /// What hovering a row adds, asked once per `<id>:<last edited>` while its peek is open; a failure counts as nothing.
    public static func previewKey(_ row: LibraryRow) -> String { "\(row.id):\(row.lastEdited)" }
    public func loadPreview(for row: LibraryRow) {
        let key = Self.previewKey(row)
        guard previews[key] == nil else { return }
        previews[key] = .some(nil)
        let data = context.data
        Task { @MainActor in
            let more = try? await data.previewLibraryItem(row.id)
            self.previews[key] = .some(more)
        }
    }
    public func preview(for row: LibraryRow) -> Library.Preview? { previews[Self.previewKey(row)] ?? nil }

    // MARK: - adding

    /// Each input its own row; the last one added flashes. What could not be added is returned, said by whoever asked.
    public func addEach(_ inputs: [String]) async -> [String] {
        var last: LibraryRow?
        var problems: [String] = []
        for input in inputs {
            do { last = try await context.data.addLibraryItem(input) } catch { problems.append(errorMessage(error)) }
        }
        if let last { await landed(last) }
        return problems
    }

    private func landed(_ row: LibraryRow) async {
        query = ""
        flash(row.id)
        await context.onLibraryChanged()
    }

    private func flash(_ id: String) {
        justAdded = id
        flashTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in if self?.justAdded == id { self?.justAdded = nil } }
        flashTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + flashTime, execute: work)
    }

    /// Add context's handlers (Rail.jsx AddToLibrary).
    public var addHandlers: HomeAddHandlers {
        HomeAddHandlers(
            onAdd: { [weak self] input in
                guard let self else { return }
                let problems = await self.addEach([input])
                if !problems.isEmpty { throw ScreensError(problems.joined(separator: " · ")) }
            },
            onPickDisk: { [weak self] in
                guard let self else { return }
                let paths = await self.context.data.pickLibraryPaths(nil)
                _ = await self.addEach(paths)
            },
            onPickRepo: { [weak self] url, row in
                guard let self else { return }
                if let row { await self.openRow(row) } else {
                    let problems = await self.addEach([url])
                    if !problems.isEmpty { throw ScreensError(problems.joined(separator: " · ")) }
                }
            },
            onSearchPick: { [weak self] pick in
                guard let self else { return }
                switch pick {
                case .item(let row): await self.openRow(row)
                case .fresh(let typed):
                    let problems = await self.addEach([typed])
                    if !problems.isEmpty { throw ScreensError(problems.joined(separator: " · ")) }
                }
            },
            library: library,
            inRail: { _ in false })
    }

    /// A drop (MATH-19): files from Finder, a picture or a link from a browser, each its own row, in order.
    public func dropAll(_ items: [Drop.Item]) async {
        if addBusy { return }
        addBusy = true
        addError = ""
        var added: [LibraryRow] = []
        var problems: [String] = []
        for item in items {
            do {
                switch item {
                case .path(let path): added.append(try await context.data.addLibraryItem(path))
                case .bytes(let data, let mime, let name): added.append(try await context.data.addLibraryFile(data, mime: mime, name: name))
                case .url(let url): added.append(try await context.data.addLibraryUrl(url))
                }
            } catch { problems.append(errorMessage(error)) }
        }
        if let last = added.last { await landed(last) }
        addBusy = false
        addError = problems.joined(separator: " · ")
    }

    // MARK: - opening

    /// A row: a note opens in its project; anything else on a workspace's Stage (2026-09-23), never in the default browser:
    /// a workspace that holds it, else the project it is in, else the one last open.
    public func openRow(_ row: LibraryRow) async {
        dropPeek()
        if row.hasTag("note"), row.projectId != nil { context.onOpenNote(row); return }
        do {
            let held = try await context.data.projectsForLibraryItem(row.id)
            if let project = held.first(where: { !$0.workspaces.isEmpty }) ?? held.first {
                context.onOpenWorkspace(project.id, project.workspaces.first?.id, row)
            } else {
                context.onOpenOnStage(row)
            }
        } catch {
            context.onOpenOnStage(row)
        }
    }

    public func openCard(_ project: PublicProject) { context.onOpenWorkspace(project.id, nil, nil) }
    public func openTile(_ project: PublicProject, _ workspace: RecentWorkspace) { dropPeek(); context.onOpenWorkspace(project.id, workspace.id, nil) }
    /// A holder in the item peek: its project, or one of its workspaces.
    public func openHolder(_ projectId: String, _ workspaceId: String?) { dropPeek(); context.onOpenWorkspace(projectId, workspaceId, nil) }

    // MARK: - rename, delete, restore

    public func startRename(_ id: String) { renaming = id }
    public func commitRename(_ project: PublicProject, _ name: String) {
        renaming = nil
        if name != project.name { context.onRename(project.id, name) }
    }
    public func cancelRename() { renaming = nil }

    /// The can: never opens the card, closes the peek, asks.
    public func askDelete(_ project: PublicProject) { dropPeek(); deleting = project }
    public func cancelDelete() { if !deleteBusy { deleting = nil } }
    public func confirmDelete() async {
        guard let project = deleting, !deleteBusy, let onDelete = context.onDelete else { return }
        deleteBusy = true
        await onDelete(project.id)
        deleteBusy = false
        deleting = nil
    }

    public func restore(_ id: String) async {
        if restoring != nil { return }
        restoring = id
        await context.onRestore(id)
        restoring = nil
    }
}

/// An error in the screens' own words.
public struct ScreensError: Error, LocalizedError, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

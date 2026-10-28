import AppKit
import EngelbartCore
import EngelbartStore
import EngelbartDoc

/// A drag or a resize of a card (views.cjs move): `begin` at the press, `move` once it moved 4 px, `end` at the release.
public enum GesturePhase: Sendable { case begin, move, end, cancel }
public enum GestureKind: String, Sendable { case drag, resize }

func errorText(_ error: Error) -> String {
    if let e = error as? LocalizedError, let text = e.errorDescription { return text }
    return String(describing: error)
}

/// A project's post-its in one window (main/post-its/views.cjs createPostItViews + renderer/post-its/ProjectPostIts.jsx).
///
/// The app makes one per workspace window, `attach(to:)`s its overlay to the window's content (above the workspace,
/// below every floating panel), and calls `activate(projectId)` while the workspace screen shows that project
/// (`activate(nil)` when it leaves, before the window closes and before quitting). Cards are `PostItCardView`s in
/// `overlay`, each with a compact `DocEditorView`; the post_its table of the project's notes.sqlite is the truth, and every
/// change is written at once.
@MainActor
public final class PostItsController: ObservableObject {
    public static let TRASH_DAYS = 7.0 // a card in the trash is purged a week after it was thrown in (2026-09-22)
    static let DAY: TimeInterval = 24 * 60 * 60
    /// A new card is square (2026-09-22).
    public static let SIDE = 260.0

    public let overlay = PostItsOverlayView()
    public var context: PostItsContext
    @Published public private(set) var projectId: String?
    /// How many cards are in this project's trash (`post-its:trash`): the sidebar's trash button shows while > 0.
    @Published public private(set) var trashCount = 0
    /// A card being dragged (`post-its:drag`): the sidebar's foot says "Drop here to throw it away".
    @Published public private(set) var drag = PostItDrag(active: false, over: false)
    /// The show/hide toggle (`post-its:hidden`).
    @Published public private(set) var hidden: Bool
    /// The window content's zoom (CSS px → points); 1 unless the app scales the window.
    public var zoom: Double = 1 { didSet { layout() } }
    /// The sidebar's trash (its foot), measured at every drag move; or a fixed rect in the overlay's coordinates.
    public weak var trashView: NSView?
    public var trashRect: PRect?

    /// For AppKit callers (SwiftUI ones observe the published values).
    public var onDrag: ((PostItDrag) -> Void)?
    public var onTrashCount: ((_ projectId: String, _ count: Int) -> Void)?
    public var onHidden: ((Bool) -> Void)?

    final class Entry {
        var row: PostItCardRow
        let view: PostItCardView
        let db: NotesDB.PostIts
        var fresh: Bool
        var build: BuildBrief?
        init(row: PostItCardRow, view: PostItCardView, db: NotesDB.PostIts, fresh: Bool) { self.row = row; self.view = view; self.db = db; self.fresh = fresh }
    }
    struct Gesture {
        let entry: Entry
        let kind: GestureKind
        let start: CGPoint
        let bounds: PRect
        let grab: CGPoint
        var moved = false
        var scale = 1.0
    }

    var entries: [String: Entry] = [:]
    var database: NotesDB.PostIts?
    var gesture: Gesture?
    var blocking: [BlockRect] = []
    /// The project's Builds as the window knows them (Workspace.jsx `builds`), in the order they came; and their progress.
    @Published public private(set) var tasks: [String: JSONValue] = [:]
    var taskOrder: [String] = []
    @Published public private(set) var progress: [String: JSONValue] = [:]
    var operations: Task<Void, Never>?
    var subscriptions: [EventHub.Token] = []
    var leavePeers: (() -> Void)?
    var stopListening: (() -> Void)?
    var monitors: [Any] = []
    var observers: [NSObjectProtocol] = []
    var responderWatch: NSKeyValueObservation?
    let panels = PostItPanels()

    public init(context: PostItsContext) {
        self.context = context
        hidden = context.visibility.hidden
        overlay.controller = self
        panels.controller = self
        stopListening = context.visibility.listen { [weak self] value in self?.applyHidden(value) }
        leavePeers = context.peers?.join(self) { [weak self] projectId, change in self?.hear(projectId, change) }
        subscriptions.append(context.events.on("engelbart:build") { [weak self] payload in
            MainActor.assumeIsolated { self?.buildState(payload) }
        })
        subscriptions.append(context.events.on("engelbart:build-progress") { [weak self] payload in
            MainActor.assumeIsolated { self?.buildProgress(payload) }
        })
    }

    /// The window closed: its cards are already gone (activate(nil)); the other windows stop telling it about theirs.
    public func dispose() {
        leavePeers?(); leavePeers = nil
        stopListening?(); stopListening = nil
        for token in subscriptions { context.events.off(token) }
        subscriptions = []
        detachWindow()
        panels.closeAll()
        overlay.removeFromSuperview()
    }

    // MARK: the window

    /// Puts the overlay over `container` (the window's content view): it fills it and stays above what is there now.
    public func attach(to container: NSView) {
        overlay.frame = container.bounds
        overlay.autoresizingMask = [.width, .height]
        container.addSubview(overlay, positioned: .above, relativeTo: nil)
        layout()
    }

    /// Back on top of the container's other subviews (call after adding a view over the workspace).
    public func bringToFront() {
        guard let container = overlay.superview else { return }
        container.addSubview(overlay, positioned: .above, relativeTo: nil)
    }

    func windowChanged() {
        detachWindow()
        guard let window = overlay.window else { return }
        // A gesture ends when the window loses the keyboard (index.cjs: win.on('blur')).
        observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cancelGesture() }
        })
        // A card taking the keyboard comes to the top (views.cjs wc.on('focus')).
        responderWatch = window.observe(\.firstResponder, options: [.new]) { [weak self] window, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.responderChanged(window) } }
        }
        // Escape in a card: the gesture cancelled and the keyboard back to the window, before the editor sees it.
        if let m = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard let self else { return event }
            return self.handleKey(event) ? nil : event
        }) { monitors.append(m) }
    }

    /// Escape with the caret in a card (views.cjs before-input-event). → whether it was used.
    func handleKey(_ event: NSEvent) -> Bool {
        guard event.keyCode == 53, event.window === overlay.window, typingEntry() != nil else { return false }
        cancelGesture()
        focusWorkspace()
        return true
    }

    func detachWindow() {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        responderWatch?.invalidate(); responderWatch = nil
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
    }

    var viewport: CGSize { overlay.bounds.size.width > 0 ? overlay.bounds.size : CGSize(width: 1200, height: 800) }

    func report(_ error: Error) { context.onError(error) }

    /// The card whose editor has the keyboard.
    func typingEntry() -> Entry? {
        guard let responder = overlay.window?.firstResponder as? NSView else { return nil }
        return entries.values.first { responder.isDescendant(of: $0.view) }
    }

    func focusWorkspace() {
        if let focus = context.focusWorkspace { focus() } else { overlay.window?.makeFirstResponder(nil) }
    }

    var lastFocused: String?
    func responderChanged(_ window: NSWindow) {
        guard let entry = typingEntry() else { lastFocused = nil; return }
        guard lastFocused != entry.row.id else { return }
        lastFocused = entry.row.id
        focus(entry)
    }

    // MARK: serial work (views.cjs exclusive)

    @discardableResult
    func exclusive<T>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = operations
        let task = Task { @MainActor () -> T in
            await previous?.value
            return try await work()
        }
        operations = Task { @MainActor in _ = try? await task.value }
        return try await task.value
    }

    // MARK: projects

    /// The cards of `projectId` (nil: none). Last edits are flushed, the trash older than a week purged, the cards listed.
    public func activate(_ id: String?) async {
        do {
            try await exclusive { [self] in
                if id == projectId { return }
                flush()
                cancelGesture()
                panels.closeAll()
                for entry in Array(entries.values) { detach(entry) }
                projectId = nil; database = nil
                tasks = [:]; taskOrder = []; progress = [:]
                trashCount = 0
                guard let id else { return }
                let dir = try await context.data.projectDir(id)
                let db = try NotesDB.open(projectDir: dir).postIts
                try db.purge(before: context.now().addingTimeInterval(-Self.TRASH_DAYS * Self.DAY))
                let rows = try db.list()
                database = db; projectId = id
                for row in rows { attach(PostItCardRow(row)) }
                raise()
                announceTrash()
                await loadTasks(id)
            }
        } catch { report(error) }
    }

    /// The project's Builds, for the cards' states (index.cjs buildFor: the latest task of each card).
    func loadTasks(_ id: String) async {
        guard let build = context.build else { return }
        guard let list = try? await build.buildList(id), projectId == id else { return }
        for task in list { remember(task) }
        for entry in entries.values {
            if let task = latestTask(entry.row.id) { applyBrief(task, to: entry) }
        }
    }

    /// Every edit is saved as it is made; this is the barrier before the cards go (views.cjs flush).
    public func flush() {
        for entry in entries.values { entry.view.editor.flush() }
    }

    /// A new card on top (2026-09-22): square, staggered, empty, with the caret in it. → its id.
    @discardableResult
    public func create(_ projectId: String? = nil) async throws -> String {
        try await exclusive { [self] in
            guard let current = self.projectId, projectId == nil || projectId == current, let database else {
                throw GeometryError("Open this project before adding a sticky")
            }
            unhide()
            let offset = Double(entries.count % 8)
            let made = try database.create(id: IDs.new(), PostItValues(text: "", nx: 0.22 + offset * 0.045, ny: 0.16 + offset * 0.045,
                                                                      width: Self.SIDE, height: Self.SIDE, z: nowMs()))
            let row = PostItCardRow(made)
            attach(row, fresh: true)
            raise()
            tell(current, .added(row))
            return row.id
        }
    }

    func nowMs() -> Double { (context.now().timeIntervalSince1970 * 1000).rounded(.down) }

    // MARK: show / hide

    /// The sidebar's toggle: every card out of sight (true) or back; nothing is written. Every window hears it.
    public func setHidden(_ value: Bool) { context.visibility.set(value) }
    public func toggleHidden() { context.visibility.toggle() }

    func applyHidden(_ value: Bool) {
        hidden = value
        if value {
            cancelGesture()
            if typingEntry() != nil { focusWorkspace() }
        }
        refresh()
        onHidden?(value)
    }

    /// A card made or brought back out of the trash while they are hidden would be invisible: they all show again.
    func unhide() { if hidden { context.visibility.set(false) } }

    /// Menus and dialogs over the window (Electron's `post-its:block`): a card under one that does not cover steps aside
    /// until it closes. Panels in Swift are child windows above the cards and cover them by themselves, so the app only
    /// needs this for something drawn inside the window that must not have cards over it.
    public func setBlocking(_ rects: [BlockRect]) throws {
        blocking = try PostItGeometry.blockingRects(rects)
        if let g = gesture, !visible(g.entry) { cancelGesture() }
        refresh()
    }

    // MARK: layout

    /// The window resized: every card placed again from its preferred layout (the one being dragged keeps its gesture).
    public func layout() {
        for entry in entries.values where gesture?.entry !== entry {
            entry.view.place(PostItGeometry.cardBounds(entry.row.layout, viewport: viewport, zoom: zoom))
        }
        refresh()
    }

    func visible(_ entry: Entry) -> Bool {
        if hidden { return false }
        if gesture?.entry === entry { return true }
        let own = PRect(entry.view.frame)
        return !blocking.contains { !$0.cover && PostItGeometry.overlaps(own, $0.rect) }
    }

    func refresh() {
        for entry in entries.values {
            let show = visible(entry)
            if entry.view.isHidden == show { entry.view.isHidden = !show }
        }
    }

    /// Cards above one another in their stacking order. Re-adding a view takes the keyboard from a card being typed in
    /// (2026-09-22: the caret left the card while writing a list), so only a wrong order is touched — by sorting the
    /// subviews in place — and a card that had the keyboard gets it back.
    func raise() {
        let order = entries.values.sorted { ($0.row.z, $0.row.id) < ($1.row.z, $1.row.id) }.map { $0.view as NSView }
        let now = overlay.subviews.filter { $0 is PostItCardView }
        if now.count == order.count && zip(now, order).allSatisfy({ $0 === $1 }) { return }
        let typing = overlay.window?.firstResponder
        var rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { (ObjectIdentifier($0.element), $0.offset) })
        withUnsafeMutablePointer(to: &rank) { pointer in
            overlay.sortSubviews({ a, b, context in
                let rank = context!.assumingMemoryBound(to: [ObjectIdentifier: Int].self).pointee
                let ra = rank[ObjectIdentifier(a)] ?? -1, rb = rank[ObjectIdentifier(b)] ?? -1
                return ra < rb ? .orderedAscending : ra > rb ? .orderedDescending : .orderedSame
            }, context: pointer)
        }
        if let typing, overlay.window?.firstResponder !== typing { overlay.window?.makeFirstResponder(typing) }
    }

    func focus(_ entry: Entry) {
        let others = entries.values.filter { $0 !== entry }.map { $0.row.z + 1 }
        entry.row.z = ([nowMs()] + others).max()!
        raise()
        save(entry)
    }

    // MARK: cards

    func attach(_ row: PostItCardRow, fresh: Bool = false) {
        guard let database else { return }
        let view = PostItCardView(frame: .zero)
        let entry = Entry(row: row, view: view, db: database, fresh: fresh)
        entries[row.id] = entry
        view.entryId = row.id
        view.controller = self
        view.isHidden = true
        overlay.addSubview(view)
        view.place(PostItGeometry.cardBounds(row.layout, viewport: viewport, zoom: zoom))
        view.load(text: row.text)
        refresh()
        if fresh && !view.isHidden { view.editor.focusStart() }
    }

    func detach(_ entry: Entry) {
        entries[entry.row.id] = nil
        if gesture?.entry === entry { cancelGesture() }
        panels.cardGone(entry.row.id)
        entry.view.editor.flush()
        entry.view.removeFromSuperview()
    }

    func entry(_ id: String) -> Entry? { entries[id] }
    /// The card views, for tests and the app's drive scripts.
    public var cards: [PostItCardView] { entries.values.sorted { $0.row.z < $1.row.z }.map(\.view) }
    public func card(_ id: String) -> PostItCardView? { entries[id]?.view }
    /// A card's row as kept now.
    public func row(_ id: String) -> PostItCardRow? { entries[id]?.row }

    /// Saves a card's row; `onCard` puts a failure on the card (an edit), else only the window hears it.
    func save(_ entry: Entry, onCard: Bool = false) {
        let row = entry.row, id = projectId
        do {
            let saved = try entry.db.update(id: row.id, row.values)
            entry.view.setError(nil)
            if saved != nil, let id { tell(id, .row(row)) }
        } catch {
            if onCard { entry.view.setError(errorText(error)) }
            report(error)
        }
    }

    func edit(_ entry: Entry, _ text: String) {
        guard text.utf16.count <= 400_000 else {
            entry.view.setError("Sticky text must be at most 400000 characters")
            return
        }
        entry.row.text = text
        save(entry, onCard: true)
    }

    /// Text that no longer fits: the card grows downwards, as far as the window lets it (the type shrinks after that).
    /// → the height (CSS px) it has now.
    @discardableResult
    func grow(_ entry: Entry, _ height: Double) -> Double {
        guard height.isFinite, height >= 0, height <= 100_000 else { return PostItGeometry.cardBounds(entry.row.layout, viewport: viewport, zoom: zoom).height / zoom }
        if gesture?.entry !== entry && height > entry.row.height {
            entry.row.layout = PostItGeometry.grown(entry.row.layout, height: height, viewport: viewport, zoom: zoom)
            entry.view.place(PostItGeometry.cardBounds(entry.row.layout, viewport: viewport, zoom: zoom))
            refresh()
            save(entry)
        }
        return PostItGeometry.cardBounds(entry.row.layout, viewport: viewport, zoom: zoom).height / zoom
    }

    func copy(_ text: String) throws {
        guard text.utf16.count <= 400_000 else { throw GeometryError("Invalid text") }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// A link on a sticky opens on the Stage, as every website does (2026-09-29).
    func openLink(_ href: String) {
        do { context.openLink(try PostItWords.externalURL(href)) } catch { report(error) }
    }

    /// +Note (2026-09-22): the card's text becomes a note of its own, in no workspace, opened as a tab; the card stays.
    func toNote(_ entry: Entry) async throws -> (id: String, name: String) {
        guard let id = projectId else { throw GeometryError("Open this project first") }
        let text = entry.row.text
        var name = PostItWords.noteName(text)
        if name == nil {
            let dir = try await context.data.projectDir(id)
            var n = 1
            while FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent("Untitled Note \(n).md")) { n += 1 }
            name = "Untitled Note \(n)"
        }
        let note = try await context.data.createNote(id, name: name!, text: text)
        context.openNote(id, note.id, note.name)
        return note
    }

    // MARK: the trash

    func announceTrash() {
        guard let database, let id = projectId else { return }
        do {
            let count = try database.trashed().count
            trashCount = count
            onTrashCount?(id, count)
        } catch { report(error) }
    }

    func throwAway(_ entry: Entry) {
        do {
            _ = try entry.db.trash(entry.row.id)
        } catch { report(error); return }
        let focused = typingEntry() === entry
        detach(entry)
        if focused { focusWorkspace() }
        announceTrash()
        if let id = projectId { tell(id, .removed(entry.row.id)) }
    }

    /// The cards in the trash, newest first, each restorable until it is a week old (purged first).
    public func trashed() async -> [TrashedPostIt] {
        (try? await exclusive { [self] () -> [TrashedPostIt] in
            guard let database else { return [] }
            try database.purge(before: context.now().addingTimeInterval(-Self.TRASH_DAYS * Self.DAY))
            return try database.trashed().map { row in
                let deleted = PostItWords.date(row.deleted ?? "") ?? context.now()
                return TrashedPostIt(id: row.id, text: row.text.slice(0, 4000), deleted: row.deleted ?? "",
                                     expires: deleted.addingTimeInterval(Self.TRASH_DAYS * Self.DAY))
            }
        }) ?? []
    }

    /// A card back out of the trash: where it was, on top. → false when it is not in the trash.
    @discardableResult
    public func restore(_ cardId: String) async throws -> Bool {
        try await exclusive { [self] in
            guard let id = projectId, let database else { throw GeometryError("Open this project before restoring a sticky") }
            guard let back = try database.restore(cardId) else { return false }
            unhide()
            var row = PostItCardRow(back)
            row.z = ([nowMs()] + entries.values.map { $0.row.z + 1 }).max()!
            _ = try database.update(id: row.id, row.values)
            attach(row)
            raise()
            announceTrash()
            tell(id, .added(row))
            return true
        }
    }

    /// "Delete task" (2026-09-27): once its task went to a workspace, the post-it can go — into the trash, as a drop does.
    @discardableResult
    public func throwOut(_ cardId: String) async throws -> Bool {
        try await exclusive { [self] in
            guard projectId != nil else { throw GeometryError("Open this project first") }
            guard let entry = entries[cardId] else { return false }
            throwAway(entry)
            return true
        }
    }

    // MARK: other windows

    func tell(_ projectId: String, _ change: PostItPeers.Change) { context.peers?.tell(from: self, projectId, change) }

    /// What another window saved (applied here, never saved again).
    func hear(_ id: String, _ change: PostItPeers.Change) {
        guard id == projectId, database != nil else { return }
        switch change {
        case .added(let row):
            guard entries[row.id] == nil else { return }
            attach(row)
            raise()
            announceTrash()
        case .removed(let cardId):
            if let entry = entries[cardId] {
                let focused = typingEntry() === entry
                detach(entry)
                if focused { focusWorkspace() }
            }
            announceTrash()
        case .row(let row):
            guard let entry = entries[row.id] else { return }
            let textChanged = entry.row.text != row.text
            entry.row = row
            if gesture?.entry !== entry { entry.view.place(PostItGeometry.cardBounds(row.layout, viewport: viewport, zoom: zoom)) }
            if textChanged { entry.view.receive(text: row.text) }
            raise()
            refresh()
        }
    }

    // MARK: gestures (views.cjs move)

    func currentTrash() -> PRect? {
        if let view = trashView {
            guard view.window === overlay.window, !view.isHiddenOrHasHiddenAncestor, view.bounds.width > 0, view.bounds.height > 0 else { return nil }
            let r = overlay.convert(view.bounds, from: view)
            return try? PostItGeometry.trashRect(PRect(x: Double(r.minX) / zoom, y: Double(r.minY) / zoom, width: Double(r.width) / zoom, height: Double(r.height) / zoom))
        }
        return trashRect
    }

    func setDrag(_ value: PostItDrag) {
        drag = value
        onDrag?(value)
    }

    public func cancelGesture() {
        guard let g = gesture else { return }
        gesture = nil
        g.entry.view.place(PostItGeometry.cardBounds(g.entry.row.layout, viewport: viewport, zoom: zoom))
        g.entry.view.gestureCancelled()
        setDrag(PostItDrag(active: false, over: false))
        refresh()
    }

    /// `point` in the overlay's coordinates (points, y down).
    func gesture(_ entry: Entry, _ phase: GesturePhase, _ kind: GestureKind, _ point: CGPoint) {
        if phase == .cancel { if gesture?.entry === entry { cancelGesture() }; return }
        guard point.x.isFinite, point.y.isFinite, abs(point.x) < 100_000, abs(point.y) < 100_000 else { return }
        let vp = viewport, scale = zoom
        if phase == .begin {
            guard visible(entry) else { return }
            cancelGesture()
            focus(entry)
            let bounds = PRect(entry.view.frame)
            let grab = CGPoint(x: max(0, min(1, (Double(point.x) - bounds.x) / bounds.width)), y: max(0, min(1, (Double(point.y) - bounds.y) / bounds.height)))
            gesture = Gesture(entry: entry, kind: kind, start: point, bounds: bounds, grab: grab)
            return
        }
        guard var g = gesture, g.entry === entry else { return }
        let dx = Double(point.x - g.start.x), dy = Double(point.y - g.start.y)
        if hypot(dx, dy) >= 4 { g.moved = true }
        let trash = currentTrash()
        let over = g.kind == .drag && PostItGeometry.inTrash(point, trash, zoom: scale)
        var b: PRect
        var crumple: Double? = nil
        if g.kind == .drag {
            let size = CGSize(width: g.bounds.width, height: g.bounds.height)
            let t = g.moved && phase != .end ? PostItGeometry.crumpleAmount(point, trash, zoom: scale) : 0
            let placed = PostItGeometry.draggedBounds(point: point, grab: g.grab, size: size, t: t, rect: trash, zoom: scale)
            b = placed.bounds
            if placed.scale != g.scale && !(phase == .end && over) {
                g.scale = placed.scale
                crumple = placed.scale
            }
        } else {
            b = g.bounds
            b.width = max(180 * scale, min(2400 * scale, b.width + dx))
            b.height = max(140 * scale, min(2400 * scale, b.height + dy))
        }
        gesture = g
        if let crumple { entry.view.setCrumple(crumple < 1 ? (crumple, CGSize(width: g.bounds.width, height: g.bounds.height)) : nil) }
        if g.moved {
            let rounded = PRect(x: PostItGeometry.round(b.x), y: PostItGeometry.round(b.y), width: PostItGeometry.round(b.width), height: PostItGeometry.round(b.height))
            entry.view.place(rounded)
            if g.kind == .drag {
                setDrag(PostItDrag(active: true, over: over))
                entry.view.setOverTrash(over)
            }
        }
        guard phase == .end else { return }
        gesture = nil
        setDrag(PostItDrag(active: false, over: false, thrown: over && g.moved))
        entry.view.setOverTrash(false)
        guard g.moved else { return }
        if over {
            Task { @MainActor [self] in _ = try? await exclusive { [self] in throwAway(entry) } }
            return
        }
        var preferred = PostItGeometry.layoutFromBounds(b, viewport: vp, zoom: scale)
        // Moving a temporarily clamped card does not shrink its preferred size.
        if g.kind == .drag { preferred.width = entry.row.width; preferred.height = entry.row.height }
        entry.row.layout = preferred
        entry.view.place(PostItGeometry.cardBounds(entry.row.layout, viewport: vp, zoom: scale))
        refresh()
        save(entry)
    }

    /// Keyboard resize (the handle focused, arrows): ±20 through the same path.
    func resizeBy(_ entry: Entry, dx: Double, dy: Double) {
        gesture(entry, .begin, .resize, .zero)
        gesture(entry, .end, .resize, CGPoint(x: dx, y: dy))
    }

    // MARK: Builds (quick tasks)

    func remember(_ task: JSONValue) {
        guard let id = task["id"]?.string else { return }
        if tasks[id] == nil { taskOrder.append(id) }
        tasks[id] = task
    }

    /// The card's latest quick task (index.cjs buildFor: the last of the project's Builds made from it).
    func latestTask(_ postItId: String) -> JSONValue? {
        for id in taskOrder.reversed() { if let t = tasks[id], t["postItId"]?.string == postItId { return t } }
        return nil
    }

    /// A Build changed (`engelbart:build`): kept for the task card, and the card it came from shows its state.
    public func buildState(_ task: JSONValue) {
        guard let pid = projectId, task["projectId"]?.string == pid else { return }
        remember(task)
        // a turn that ended leaves nothing to show as progress
        if let id = task["id"]?.string, !BuildBrief.working.contains(task["status"]?.string ?? "") { progress[id] = nil }
        if let postItId = task["postItId"]?.string, let entry = entries[postItId] { applyBrief(task, to: entry) }
        panels.taskChanged()
    }

    func buildProgress(_ payload: JSONValue) {
        guard let pid = projectId, payload["projectId"]?.string == pid, let id = payload["id"]?.string, let activity = payload["activity"]?.string, !activity.isEmpty else { return }
        var held = progress[id]?.object ?? [:]
        held["activity"] = .string(activity)
        progress[id] = .object(held)
        panels.taskChanged()
    }

    func applyBrief(_ task: JSONValue, to entry: Entry) {
        guard let id = task["id"]?.string, let status = task["status"]?.string else { return }
        let kind = task["kind"]?.string ?? "quick"
        var brief = BuildBrief(id: id, status: status, final: task["final"]?.bool ?? false, kind: kind)
        entry.build = brief
        entry.view.setBuild(brief)
        if kind == "build", let workspaceId = task["workspaceId"]?.string, let pid = projectId {
            Task { @MainActor [weak self] in
                guard let self, let name = await self.context.data.workspaceName(pid, workspaceId), self.entries[entry.row.id] === entry, entry.build?.id == id else { return }
                brief.workspace = name
                entry.build = brief
                entry.view.setBuild(brief)
            }
        }
    }

    /// The Build button: the popup hangs from it with the card's text; a second press closes it (Workspace.jsx onBuildQuick).
    func askBuild(_ entry: Entry, from button: NSView) {
        focusWorkspace()
        panels.toggleBuild(postItId: entry.row.id, text: entry.row.text, anchor: button)
    }

    /// A click on the card's state: a task added to a workspace goes there; else its task card (Workspace.jsx onBuildQuickOpen).
    func openBuild(_ entry: Entry, from button: NSView) {
        guard let brief = entry.build else { return }
        focusWorkspace()
        panels.closeBuild()
        if let task = tasks[brief.id], task["kind"]?.string == "build", let ws = task["workspaceId"]?.string, let version = task["version"], !version.isNull {
            panels.closeTask()
            context.goToVersion(ws, version)
            return
        }
        panels.toggleTask(id: brief.id, postItId: entry.row.id, anchor: .view(button))
    }

    /// A sticky's quick task picked in the Agents panel (Workspace.jsx goAgent): the stickies shown, its task card at `rect`
    /// (the row's, window content coordinates, y down).
    public func openQuickTask(id: String, postItId: String?, anchor rect: CGRect?) {
        setHidden(false)
        panels.closeBuild()
        panels.openTask(id: id, postItId: postItId, anchor: rect.map { .rect($0) } ?? .none)
    }
}

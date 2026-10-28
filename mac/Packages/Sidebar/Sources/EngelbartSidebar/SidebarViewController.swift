import AppKit
import SwiftUI
import EngelbartCore
import EngelbartDoc
import EngelbartIntegrations
import EngelbartStore
import EngelbartUI

// The sidebar (src/renderer/workspace/Rail.jsx, redone 2026-10-13 from Hudson's "Sidebar" project and the mockup built
// from it, design/sidebar-mockup/Sidebar.html: "it is exactly how I want it"). What were workspaces are projects now: the
// top-level project the switcher picks, and the projects nested in it, four levels in all. From the top:
//   the head: the top-level project's name and its chevron (which never turns), opening its menu (Switch project, Rename,
//     Project page, Keyboard shortcuts); then Settings and New note;
//   fixed rows: Agents (the Inbox folded in; a count in a rounded square, its outline breathing while one runs, filled grey
//     once all of them wait for you, 9+), Library (its size, 999+), Search;
//   Projects: at most three level-2 projects, a shortlist a click never reorders, ten rows in all counting what is open under
//     them and every More; one path open at a time; a group shows five, or four and More; a guide line only beside the
//     deepest group open; counts roll up, each agent once; the + (on hover) makes a project within that one; a level-2
//     project you are not in shows its chevron on hover; resting on a folded project shows what is in it; Ctrl+1–9 and ⌘J;
//   Sources: this project's folder (its sources, five or four and More), then the person's own folders, the same in every
//     project, and Create new; + adds to the project or, on a folder, to that folder;
//   the foot: the stickies shown or hidden, and the trash when it holds something.
// Chevrons point down while open and up while folded. The sidebar folds away from the toggle in the title bar or ⌘\
// (the Workspace's).

@MainActor
public final class SidebarViewController: NSViewController {
    public let context: SidebarContext
    public private(set) var input: SidebarInput

    // MARK: state (Rail.jsx's useState)

    /// What is folded open (engelbart.sidebar.open).
    private(set) var opened: [String: Bool]
    /// What is open in Projects: follows where you are; a chevron changes it until you go elsewhere.
    private(set) var expanded: Set<String> = []
    private var shownFor: String?? = .none
    /// Top-level project id → its shortlist (engelbart.sidebar.slots).
    private(set) var slotsAll: [String: [String]]
    /// One panel beside the sidebar at a time.
    struct Panel: Equatable {
        var kind: String
        var key: String? = nil
        var anchor: CGRect
        var chip: String? = nil
        var parentId: String? = nil
        var folderId: String? = nil
        var from: CGRect? = nil
    }
    private(set) var panel: Panel?
    private(set) var searching = false
    private(set) var shortcuts = false
    private(set) var creating: (id: String?, name: String)? = nil
    private(set) var makingFolder = false
    /// 'project', or the id of a project, a source or a folder being renamed.
    private(set) var renaming: String?
    private(set) var dropping = false
    private(set) var flyout: (id: String, anchor: CGRect)? = nil
    private(set) var tip: (rect: CGRect, kind: String, n: Int, label: String)? = nil
    public private(set) var folders: [AppState.Folder] = []
    private var tourOpened = false

    // MARK: derived

    private(set) var tree = TreeIndex()
    private(set) var counts: [String: AgentSummary] = [:]
    private(set) var plan = ProjectPlan(order: [], shown: [], hidden: [], visible: [], opened: [], guide: nil, rows: 0)

    // MARK: views and floating things

    let root = SidebarRootView()
    let peek: PeekController
    private let panelHost = FloatingPanel()
    private let switchHost = FloatingPanel()
    private let sideHost = FloatingPanel()
    private let menuHost = FloatingPanel()
    private let dialog = CenteredDialog()
    let flyCard = CardWindow(passive: false)
    private let tipCard = CardWindow(passive: true)
    private var flyTimer: Timer?
    private var tipTimer: Timer?
    private weak var tipFor: NSView?
    private var hubTokens: [EventHub.Token] = []
    private var escMonitor: Any?
    private var pickerPoll: Timer?
    private var pickerLeaveAt: Date?
    private var switchShut: Timer?
    private var switchList: [PublicProject]? = nil
    private var lookup: LookupModel
    /// The panel models alive while their panel is open (tests read them).
    private(set) var libraryModel: LibraryPanelModel?
    private(set) var addModel: AddPickerModel?
    private(set) var sideModel: LibraryPanelModel?
    private(set) var searchModel: SearchDialogModel?
    private(set) var nameModel: NameDialogModel?
    private(set) var projectsModel: ProjectsPanelModel?
    private(set) var menuItems: [MenuItemSpec]? = nil
    /// Row views by their identifier (`sb-project-row=ui`), rebuilt with the list.
    var rows: [String: NSView] = [:]

    public init(context: SidebarContext, input: SidebarInput) {
        self.context = context
        self.input = input
        self.opened = context.storage.opened()
        self.slotsAll = context.storage.slots()
        self.peek = PeekController(timing: context.timing, preview: context.services.preview)
        self.lookup = LookupModel(ask: context.services.lookup, delay: context.timing.lookup)
        if let given = input.folders { folders = given }
        super.init(nibName: nil, bundle: nil)
        peek.onOpenWorkspace = { [weak self] pid, wid in self?.context.actions.openHeld(pid, wid) }
        peek.onChange = { [weak self] in self?.installEscape() }
        panelHost.onClose = nil
    }
    required init?(coder: NSCoder) { fatalError() }

    public override func loadView() {
        view = root
        root.frame = CGRect(x: 0, y: 0, width: input.width, height: 600)
        wire()
        recompute()
        render()
        if input.folders == nil { loadFolders() }
        hubTokens.append(context.hub.on("engelbart:folders") { [weak self] payload in
            MainActor.assumeIsolated {
                guard let self, self.input.folders == nil, let list = StoreValues.folders(payload) else { return }
                self.folders = list
                self.render()
            }
        })
        NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: root.scroll.contentView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.peek.drop(); self?.quiet() }
        }
    }

    deinit {
        for token in hubTokens { context.hub.off(token) }
    }

    // MARK: public surface

    /// New data from the Workspace: redrawn; what is open resets when the project here changed.
    public func update(_ next: SidebarInput) {
        let before = input
        input = next
        if let given = next.folders { folders = given }
        else if before.folders != nil { loadFolders() }
        if before.tourStep != next.tourStep { tourChanged(next.tourStep) }
        if before.hidden != next.hidden && next.hidden { closeEverything() }
        recompute()
        render()
    }

    /// The Welcome walkthrough (2026-10-09): opens Library on that chip (Rail.jsx `libraryRequest`).
    public func openLibrary(chip: String = "all") {
        guard !input.hidden, let row = rows["sb-trigger=library"] else { return }
        peek.drop()
        open(Panel(kind: "library", anchor: anchorOf(row), chip: chip))
    }

    /// The drop target for a sticky dragged to the trash (Rail.jsx `trashRef`): the foot.
    public var trashView: NSView { root.foot }

    /// Where the sidebar tour's holes are for `step` (window content, y down), as SidebarTour.jsx measures them.
    public func tourHoles(step: Int) -> [CGRect] { tourRects(step) }

    /// The panel open beside the sidebar (`agents`, `library`, `add`, `projects`, `siblings`, `sources`, `project`), if any.
    public var openPanel: String? { panel?.kind }

    // MARK: data

    private func loadFolders() {
        Task { [weak self] in
            guard let self, let list = try? await self.context.services.folders() else { return }
            if self.input.folders == nil { self.folders = list; self.render() }
        }
    }

    func recompute() {
        tree = SidebarModel.indexTree(input.roots)
        counts = SidebarModel.rollUp(tree, input.entries)
        if shownFor != .some(input.hereId) { shownFor = .some(input.hereId); expanded = SidebarModel.openPath(tree, input.hereId) }
        let held = slotsAll[input.project.id]
        let order = SidebarModel.projectSlots(roots: input.roots, index: tree, focusId: input.hereId, held: held, recency: recency())
        if held != order {
            slotsAll[input.project.id] = order
            context.storage.setSlots(slotsAll)
        }
        plan = SidebarModel.projectPlan(index: tree, order: order, expanded: expanded)
    }

    /// When each level-2 project was last worked in, with everything in it: written in, or gone to (the clock's visits).
    func recency() -> [String: Double] {
        let (_, within) = SidebarModel.workspaceActivity(input.roots, recent: input.recent)
        var out: [String: Double] = [:]
        for node in input.roots { out[node.id] = within[node.id] ?? 0 }
        for visit in input.visits where visit.kind == "project" {
            guard let top = tree[visit.id]?.path.first else { continue }
            let at = JSTime.ms(visit.at)
            if at > (out[top] ?? 0) { out[top] = at }
        }
        return out
    }

    func isOpen(_ key: String, _ fallback: Bool) -> Bool { opened[key] ?? fallback }
    func toggleStored(_ key: String, _ fallback: Bool) {
        opened[key] = !(opened[key] ?? fallback)
        context.storage.setOpened(opened)
        render()
    }

    // MARK: wiring the fixed pieces

    private func wire() {
        root.head.project.action = { [weak self] button in self?.togglePanel("project", element: button) }
        root.head.settings.action = { [weak self] _ in self?.close(); self?.context.actions.openSettings() }
        root.head.newNote.action = { [weak self] _ in self?.close(); self?.newNote(folderId: nil) }
        root.foot.toggle.onClick = { [weak self] _ in guard let self, self.input.canToggleStickies else { return }; self.context.actions.toggleStickies() }
        root.foot.trash.action = { [weak self] button in self?.togglePanel("trash", element: button) }
        root.onDragOver = { [weak self] info in
            guard let self else { return }
            let on = info != nil
            if self.dropping != on { self.dropping = on; self.root.list.dropping = on }
        }
        root.onDrop = { [weak self] info in self?.drop(info) ?? false }
    }

    // MARK: panels

    /// Panels hang beside the sidebar at the height of the row that opened them: the row's left, top and bottom, the
    /// sidebar's right (window content, y down).
    func anchorOf(_ element: NSView) -> CGRect {
        var row: NSView = element
        while !(row is SBRowView), let up = row.superview, up !== root.list { row = up }
        let r = FloatingPanel.anchorRect(of: row)
        let side = FloatingPanel.anchorRect(of: root)
        return CGRect(x: r.minX, y: r.minY, width: max(0, side.maxX - r.minX), height: r.height)
    }

    /// A second press on what opened a panel closes it.
    func togglePanel(_ kind: String, element: NSView, key: String? = nil, parentId: String? = nil, folderId: String? = nil) {
        peek.drop()
        hideFlyout()
        if let p = panel, p.kind == kind, p.key == key { close(); return }
        let anchor = kind == "project" ? FloatingPanel.anchorRect(of: element) : anchorOf(element)
        open(Panel(kind: kind, key: key, anchor: anchor, parentId: parentId, folderId: folderId, from: kind == "add" ? FloatingPanel.anchorRect(of: element) : nil))
    }

    func open(_ next: Panel) {
        closeFloating()
        panel = next
        render()
        present()
        context.actions.panelOpened(next.kind)
    }

    /// Closes the panel beside the sidebar.
    public func close() {
        guard panel != nil else { return }
        closeFloating()
        panel = nil
        render()
    }

    private func closeFloating() {
        for host in [panelHost, switchHost, sideHost] { host.onClose = nil; host.close() }
        pickerPoll?.invalidate(); pickerPoll = nil
        libraryModel?.lookup.stop(); libraryModel = nil
        addModel = nil; sideModel = nil; projectsModel = nil; switchList = nil
    }

    func closeEverything() {
        close(); peek.drop(); quiet()
        menuHost.close(); dialog.close()
        searching = false; shortcuts = false; creating = nil; makingFolder = false
    }

    private var window: NSWindow? { root.window }

    private func ignoreRect(_ id: String) -> CGRect? { rows[id].map { FloatingPanel.anchorRect(of: $0) } }

    private func show<V: View>(_ host: FloatingPanel, anchor: CGRect, side: PlaceSide = .right, gap: CGFloat = 8, width: CGFloat, cap: CGFloat, ignore: CGRect?, padding: CGFloat = 0, _ content: V) {
        guard let window else { return }
        host.onClose = nil
        host.show(in: window, anchor: anchor, options: FloatingOptions(side: side, gap: gap, cap: cap, width: width, ignore: ignore)) {
            content.padding(padding).frame(width: width, alignment: .topLeading)
        }
    }

    /// Draws the open panel.
    func present() {
        guard let p = panel, window != nil else { return }
        let a = context.actions
        switch p.kind {
        case "project":
            show(panelHost, anchor: p.anchor, side: .below, gap: 4, width: 230, cap: 560, ignore: FloatingPanel.anchorRect(of: root.head.project), projectMenu())
        case "agents":
            let view = AgentsPanelView(entries: input.entries, crumbOf: { [weak self] id in self?.crumbOf(id) ?? [] }, dismissable: a.dismissAgent != nil,
                                       onGo: { [weak self] entry, _ in
                                           // the row's rect (Electron passes it for the quick task's card): the panel's width at the pointer's height
                                           let rect = self.flatMap { me in me.window.map { w -> CGRect in
                                               let p = Self.contentPoint(NSEvent.mouseLocation, in: w)
                                               let left = me.panelHost.spot?.left ?? p.x
                                               return CGRect(x: left, y: p.y - 17, width: me.panelHost.cardSize.width, height: 34)
                                           } }
                                           self?.close(); a.goAgent(entry, rect) },
                                       onDismiss: { entry in a.dismissAgent?(entry) },
                                       onNext: { [weak self] in self?.close(); a.nextAgent() }, onSeenAll: a.seenAll)
            show(panelHost, anchor: p.anchor, width: 360, cap: 620, ignore: ignoreRect("sb-trigger=agents"), view)
        case "library":
            let model = libraryModel ?? LibraryPanelModel(chip: p.chip ?? "all", library: input.library, inRail: { [weak self] in self?.input.inRail.contains($0) ?? false }, lookup: LookupModel(ask: context.services.lookup, delay: context.timing.lookup))
            if libraryModel == nil {
                libraryModel = model
                model.bodies.load(projectId: input.project.id, ask: context.services.bodies)
                model.onOpen = { row in a.openRow(row) }
                model.onLink = { row in try await a.linkRow(row) }
                model.onAddInput = { input in _ = try await a.addInput(input) }
                model.onClose = { [weak self] in self?.close() }
            }
            show(panelHost, anchor: p.anchor, width: 360, cap: 600, ignore: ignoreRect("sb-trigger=library"),
                 LibraryPanelView(model: model, peek: peek, onOpenFull: a.allProjects))
        case "add":
            presentAdd(p)
        case "projects":
            let model = projectsModel ?? ProjectsPanelModel(roots: input.roots, tree: tree, hereId: input.hereId)
            projectsModel = model
            show(panelHost, anchor: p.anchor, width: 340, cap: 620, ignore: ignoreRect("sb-more=projects"),
                 ProjectsPanelView(model: model, counts: counts, hereId: input.hereId, onGo: { [weak self] id in self?.close(); self?.go(id) },
                                   onNew: { [weak self] in self?.close(); self?.create(nil) }, onMenu: { [weak self] id, event in self?.projectMenu(id, at: nil) },
                                   onOpenVersion: { [weak self] v in self?.close(); a.openVersion(v) }))
        case "siblings":
            guard let parent = p.parentId, tree.has(parent) else { close(); return }
            let ids = tree[parent]!.node.children.map(\.id)
            show(panelHost, anchor: p.anchor, width: 320, cap: 560, ignore: p.key.flatMap { ignoreRect("sb-more=\($0)") ?? ignoreRect("sb-chevron=\($0)") },
                 SiblingsPanelView(ids: ids, tree: tree, counts: counts, hereId: input.hereId, onGo: { [weak self] id in self?.close(); self?.go(id) },
                                   onMenu: { [weak self] id, _ in self?.projectMenu(id, at: nil) }, onOpenVersion: { [weak self] v in self?.close(); a.openVersion(v) }))
        case "sources":
            let folder = p.folderId.flatMap { id in folders.first { $0.id == id } }
            let list = folder.map(folderRowsOf) ?? input.rows
            let title = folder?.name ?? nameOf(input.hereId) ?? input.project.name
            let remove: ((LibraryRow) -> Void) = folder != nil ? { [weak self] row in self?.removeFromFolder(folder!.id, row.id) } : { [weak self] row in if self?.input.inRail.contains(row.id) == true { a.removeRow(row) } }
            show(panelHost, anchor: p.anchor, width: 330, cap: 620, ignore: ignoreRect("sb-more=\(p.key ?? "project")"),
                 SourcesPanelView(title: title, rows: list, activeId: input.activeRowId, removeLabel: folder.map { "Remove from \($0.name)" } ?? "Remove from this project", peek: peek,
                                  onOpen: { [weak self] row in self?.close(); a.openRow(row) }, onRemove: remove))
        case "trash":
            guard let window else { return }
            let rect = FloatingPanel.anchorRect(of: root.foot.trash)
            panel = nil
            render()
            a.openTrash(window, rect)
            return
        default: break
        }
        panelHost.onClose = { [weak self] in
            guard let self else { return }
            self.panelHost.onClose = nil
            if self.panel != nil { self.closeFloating(); self.panel = nil; self.render() }
        }
    }

    // MARK: the project menu

    private func projectMenu() -> some View {
        if switchList == nil {
            Task { [weak self] in
                let list = (try? await self?.context.services.listProjects()) ?? []
                self?.switchList = list
                self?.refreshSwitch()
            }
        }
        return ProjectMenuView(switchOpen: switchHost.isOpen,
                               onSwitchHover: { [weak self] _ in self?.openSwitch() },
                               onSwitch: { [weak self] in self?.openSwitch() },
                               onOtherHover: { [weak self] in self?.shutSwitchSoon() },
                               onRename: { [weak self] in self?.close(); self?.startRename("project") },
                               onProjectPage: { [weak self] in self?.close(); self?.context.actions.openProjectPage() },
                               onShortcuts: { [weak self] in self?.close(); self?.showShortcuts() })
    }

    /// The list beside Switch project opens on hover or a press; it closes a moment after the pointer moves onto another row,
    /// and not at all when it reaches the list (the way there crosses Rename on a slant: 2026-10-13).
    func openSwitch() {
        switchShut?.invalidate(); switchShut = nil
        guard !switchHost.isOpen, let spot = panelHost.spot else { refreshSwitch(); return }
        // the Switch row: the menu's first row (5 in from the card's top), 32 high; the list's top 5 above it
        let r = CGRect(x: spot.left, y: spot.top + 5 - 5, width: panelHost.cardSize.width, height: 32 + 5)
        show(switchHost, anchor: r, side: .right, gap: 6, width: 250, cap: 460, ignore: r, switchView())
        switchHost.onClose = { [weak self] in self?.panelHost.update { self?.projectMenu().frame(width: 230, alignment: .topLeading) } }
        panelHost.update { [weak self] in self?.projectMenu().frame(width: 230, alignment: .topLeading) }
    }
    func shutSwitchSoon() {
        switchShut?.invalidate()
        guard switchHost.isOpen else { return }
        switchShut = Timer.scheduledTimer(withTimeInterval: context.timing.switchShut, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.switchHost.close() }
        }
    }
    private func refreshSwitch() { if switchHost.isOpen { switchHost.update { [weak self] in self?.switchView().frame(width: 250, alignment: .topLeading) } } }
    private func switchView() -> some View {
        let a = context.actions
        return SwitchListView(list: switchList, currentId: input.project.id, counts: input.projectCounts,
                              onPick: { [weak self] id in self?.close(); if id != self?.input.project.id { a.openProject(id) } },
                              onNewProject: { [weak self] in self?.close(); a.newProject() },
                              onAllProjects: { [weak self] in self?.close(); a.allProjects() },
                              onHover: { [weak self] in self?.switchShut?.invalidate(); self?.switchShut = nil })
            .padding(0)
    }

    // MARK: the add picker

    private func presentAdd(_ p: Panel) {
        let a = context.actions
        let folder = p.folderId.flatMap { id in folders.first { $0.id == id } }
        let model: AddPickerModel
        if let held = addModel { model = held } else {
            model = AddPickerModel(intoName: folder?.name ?? nameOf(input.hereId) ?? input.project.name, library: input.library,
                                   has: { [weak self] id in
                                       guard let self else { return false }
                                       if let fid = p.folderId { return self.folders.first { $0.id == fid }?.items.contains(id) ?? false }
                                       return self.input.inRail.contains(id)
                                   })
            model.onPick = { [weak self] row in
                if let fid = p.folderId { try await self?.addToFolder(fid, [row.id]) } else { try await a.linkRow(row) }
            }
            model.onAddInput = { [weak self] text in
                guard let self else { throw StoreError("Gone") }
                return try await self.addInput(text, folderId: p.folderId)
            }
            model.onPickRepo = { [weak self] entry in try await self?.pickRepo(entry, folderId: p.folderId) }
            model.pickPaths = context.services.pickPaths
            addModel = model
        }
        model.library = input.library
        show(panelHost, anchor: p.anchor, width: 320, cap: 620, ignore: ignoreRect("sb-trigger=add:\(p.key ?? "project")"),
             AddPickerView(model: model, github: context.github, inRail: { [weak self] in self?.input.inRail.contains($0) ?? false }, peek: peek,
                           onMore: { [weak self] in self?.toggleSideLibrary() }))
        // While it is adding nothing closes it (FloatingPanel's Escape and outside press are let through only when idle).
        startPickerPoll(from: p.from)
    }

    /// The whole library beside the picker (its More), as a picker.
    func toggleSideLibrary() {
        guard let model = addModel, let p = panel, p.kind == "add" else { return }
        if sideHost.isOpen { sideHost.close(); model.sideOpen = false; sideModel = nil; return }
        let side = LibraryPanelModel(library: input.library, inRail: { [weak self] in self?.input.inRail.contains($0) ?? false },
                                     picking: .init(has: model.has, onPick: { row in try await model.onPick(row); model.remember(row) }),
                                     lookup: LookupModel(ask: context.services.lookup, delay: context.timing.lookup))
        side.bodies.load(projectId: input.project.id, ask: context.services.bodies)
        side.onAddInput = { text in model.remember(try await model.onAddInput(text), text) }
        side.onClose = { [weak self] in self?.sideHost.close(); model.sideOpen = false; self?.sideModel = nil }
        sideModel = side
        model.sideOpen = true
        let card = panelHost.spot.map { CGRect(x: $0.left, y: $0.top, width: panelHost.cardSize.width, height: panelHost.cardSize.height) } ?? p.anchor
        show(sideHost, anchor: card, width: 360, cap: 600, ignore: nil, LibraryPanelView(model: side, peek: peek, onOpenFull: {}))
        sideHost.onClose = { model.sideOpen = false }
    }

    /// Hiding by itself: the pointer more than a little outside the picker, the library beside it, a peek and the + itself,
    /// for 180 ms; never while it stays (adding, GitHub, a typed link).
    private func startPickerPoll(from: CGRect?) {
        pickerPoll?.invalidate()
        pickerLeaveAt = nil
        pickerPoll = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let model = self.addModel, let window = self.window else { return }
                let point = Self.contentPoint(NSEvent.mouseLocation, in: window)
                if self.pickerKeeps(point, model: model, from: from) { self.pickerLeaveAt = nil; return }
                if self.pickerLeaveAt == nil { self.pickerLeaveAt = Date() }
                if Date().timeIntervalSince(self.pickerLeaveAt!) >= self.context.timing.pickerLeave && !model.stays { self.close() }
            }
        }
    }
    func pickerKeeps(_ point: CGPoint, model: AddPickerModel, from: CGRect?) -> Bool {
        if model.stays { return true }
        var boxes: [CGRect] = []
        if let spot = panelHost.spot { boxes.append(CGRect(x: spot.left, y: spot.top, width: panelHost.cardSize.width, height: panelHost.cardSize.height)) }
        if sideHost.isOpen, let spot = sideHost.spot { boxes.append(CGRect(x: spot.left, y: spot.top, width: sideHost.cardSize.width, height: sideHost.cardSize.height)) }
        if let from { boxes.append(from) }
        if peek.isShowing, let p = peek.peek { boxes.append(CGRect(x: p.edge, y: p.rect.minY - 12, width: 368, height: 440)) }
        return AddPickerModel.inside(point, boxes: boxes)
    }
    static func contentPoint(_ screen: CGPoint, in window: NSWindow) -> CGPoint {
        let p = window.convertPoint(fromScreen: screen)
        guard let content = window.contentView else { return p }
        let local = content.convert(p, from: nil)
        return content.isFlipped ? local : CGPoint(x: local.x, y: content.bounds.height - local.y)
    }

    // MARK: adding into a folder or the project (Workspace.jsx addInputTo, pickFromDiskTo, pickRepoTo, newNoteIn)

    func addInput(_ text: String, folderId: String?) async throws -> LibraryRow {
        guard let folderId else { return try await context.actions.addInput(text) }
        let row = try await AddOrFind.addOrFind(text, add: context.services.addLibraryItem, lookup: context.services.lookup)
        await context.actions.libraryChanged()
        try await addToFolder(folderId, [row.id])
        return row
    }
    func pickRepo(_ entry: GithubRow, folderId: String?) async throws {
        guard let folderId else { try await context.actions.pickRepo(entry); return }
        let id: String
        if let held = entry.row { id = held.id } else { id = try await AddOrFind.addOrFind(entry.repo.url, add: context.services.addLibraryItem, lookup: context.services.lookup).id }
        await context.actions.libraryChanged()
        try await addToFolder(folderId, [id])
    }
    func newNote(folderId: String?) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let id = try await self.context.actions.newNote()
                if let folderId, let id { try await self.addToFolder(folderId, [id]) }
            } catch {}
        }
    }

    // MARK: folders (Workspace.jsx: the person's folders, the same in every project)

    func addToFolder(_ folderId: String, _ ids: [String]) async throws {
        let next = try await context.services.addToFolder(folderId, ids)
        folders = next
        render()
        if let last = ids.last { context.actions.flash(last) }
    }
    func removeFromFolder(_ folderId: String, _ id: String) {
        Task { [weak self] in
            guard let self, let next = try? await self.context.services.removeFromFolder(folderId, id) else { return }
            self.folders = next; self.render()
        }
    }
    func renameFolder(_ folderId: String, _ name: String) {
        Task { [weak self] in
            guard let self, let next = try? await self.context.services.renameFolder(folderId, name) else { return }
            self.folders = next; self.render()
        }
    }
    func deleteFolder(_ folderId: String) {
        Task { [weak self] in
            guard let self, let next = try? await self.context.services.deleteFolder(folderId) else { return }
            self.folders = next; self.render()
        }
    }
    func folderRowsOf(_ folder: AppState.Folder) -> [LibraryRow] {
        let byId = Dictionary(input.library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return folder.items.compactMap { byId[$0] }
    }

    // MARK: projects

    func nameOf(_ id: String?) -> String? { tree[id]?.node.name }
    func crumbOf(_ id: String) -> [String] { tree[id]?.path.compactMap { tree[$0]?.node.name } ?? [] }

    func go(_ id: String) { quiet(); context.actions.selectWorkspace(id) }

    func chevronPress(_ id: String, element: NSView) {
        quiet()
        // open, with no room for what is in it: Siblings instead
        if expanded.contains(id) && !plan.opened.contains(id) { togglePanel("siblings", element: element, key: id, parentId: id); return }
        expanded = SidebarModel.toggleOpen(tree, expanded, id)
        recompute()
        render()
    }

    func create(_ parentId: String?) {
        quiet(); close()
        creating = parentId.map { ($0, nameOf($0) ?? "") } ?? (nil, input.project.name)
        let parent = creating!
        let model = NameDialogModel(title: "Create project within \(parent.name)", placeholder: "Name", action: "Create") { [weak self] name in
            try await self?.context.actions.createWorkspace(name, parent.id)
        }
        showName(model) { [weak self] in self?.creating = nil }
    }

    func makeFolder() {
        close()
        makingFolder = true
        let model = NameDialogModel(title: "Create folder", placeholder: "Folder name", action: "Create folder") { [weak self] name in
            guard let self else { return }
            let next = try await self.context.services.createFolder(name)
            self.folders = next
            self.render()
        }
        showName(model) { [weak self] in self?.makingFolder = false }
    }

    private func showName(_ model: NameDialogModel, done: @escaping () -> Void) {
        guard let window else { return }
        nameModel = model
        model.onClose = { [weak self] in self?.dialog.close() }
        dialog.canClose = { !model.busy }
        dialog.onClose = { [weak self] in done(); self?.nameModel = nil }
        dialog.show(in: window, width: 440, label: model.title, NameDialogView(model: model))
    }

    func showSearch() {
        close()
        guard let window else { return }
        searching = true
        render()
        let a = context.actions
        let model = SearchDialogModel(workspaces: NavModel.flatWorkspaces(input.roots), rows: input.rows, library: input.library,
                                      inRail: { [weak self] in self?.input.inRail.contains($0) ?? false }, lookup: LookupModel(ask: context.services.lookup, delay: context.timing.lookup))
        model.bodies.load(projectId: input.project.id, ask: context.services.bodies)
        model.onGoWorkspace = { [weak self] id in self?.go(id) }
        model.onOpen = { row in a.openRow(row) }
        model.onLink = { row in Task { try? await a.linkRow(row) } }
        model.onAddInput = { text in _ = try await a.addInput(text) }
        model.onClose = { [weak self] in self?.dialog.close() }
        searchModel = model
        dialog.canClose = { true }
        dialog.onClose = { [weak self] in self?.searching = false; self?.searchModel = nil; self?.render() }
        dialog.show(in: window, width: 560, label: "Search", SearchDialogView(model: model))
    }

    func showShortcuts() {
        guard let window else { return }
        shortcuts = true
        let a = context.actions
        dialog.canClose = { true }
        dialog.onClose = { [weak self] in self?.shortcuts = false }
        dialog.show(in: window, width: 480, label: "Keyboard shortcuts",
                    ShortcutsDialogView(roots: input.roots, railHidden: input.railHidden,
                                        onNext: { [weak self] in self?.dialog.close(); a.nextAgent() },
                                        onGo: { [weak self] id in self?.dialog.close(); self?.go(id) },
                                        onToggleRail: { [weak self] in self?.dialog.close(); a.toggleRail() },
                                        onClose: { [weak self] in self?.dialog.close() }))
    }

    // MARK: right-click menus

    func showMenu(_ items: [MenuItemSpec], at point: CGPoint) {
        guard let window else { return }
        menuItems = items
        menuHost.onClose = { [weak self] in self?.menuItems = nil }
        menuHost.show(in: window, anchor: CGRect(origin: point, size: .zero), options: FloatingOptions(side: .below, gap: 0, cap: 520, radius: 9)) {
            ContextMenuView(items: items) { [weak self] item in self?.menuHost.close(); item.action() }
        }
    }
    func pointOf(_ event: NSEvent?) -> CGPoint {
        guard let window, let event else { return .zero }
        return Self.contentPoint(window.convertPoint(toScreen: event.locationInWindow), in: window)
    }

    func projectMenu(_ id: String, at event: NSEvent?) {
        quiet()
        guard let at = tree[id] else { return }
        let deep = at.level >= SidebarModel.MAX_DEPTH
        let a = context.actions
        showMenu([
            MenuItemSpec(label: "Open", icon: SidebarIcons.workspace) { [weak self] in self?.go(id) },
            MenuItemSpec(label: "Create project within \(at.node.name)", icon: SidebarIcons.plus, disabled: deep, title: deep ? "Projects go four levels deep" : nil) { [weak self] in self?.create(id) },
            MenuItemSpec(label: "Rename", icon: SidebarIcons.pencil) { [weak self] in self?.startRename(id) },
            .separatorItem,
            MenuItemSpec(label: "Delete", icon: SidebarIcons.trash, danger: true) { a.deleteWorkspace(id) },
        ], at: event.map(pointOf) ?? NSEvent.mouseLocation.applying(.identity).contentIn(window))
    }

    func sourceMenu(_ row: LibraryRow, folder: AppState.Folder?, event: NSEvent) {
        peek.drop()
        let a = context.actions
        let into = folders.filter { f in folder.map { f.id != $0.id } ?? true }.filter { !$0.items.contains(row.id) }.prefix(6)
        var items: [MenuItemSpec] = [
            MenuItemSpec(label: "Open", icon: SidebarIcons.external) { a.openRow(row) },
            MenuItemSpec(label: "Rename", icon: SidebarIcons.pencil) { [weak self] in self?.startRename(row.id) },
        ]
        items += into.map { f in MenuItemSpec(label: "Add to \(f.name)", icon: SidebarIcons.folder) { [weak self] in Task { try? await self?.addToFolder(f.id, [row.id]) } } }
        if let folder { items += [.separatorItem, MenuItemSpec(label: "Remove from \(folder.name)", icon: SidebarIcons.minusCircle) { [weak self] in self?.removeFromFolder(folder.id, row.id) }] }
        else if input.inRail.contains(row.id) { items += [.separatorItem, MenuItemSpec(label: "Remove from this project", icon: SidebarIcons.minusCircle) { a.removeRow(row) }] }
        showMenu(items, at: pointOf(event))
    }

    func folderMenu(_ folder: AppState.Folder, event: NSEvent) {
        showMenu([
            MenuItemSpec(label: "Rename", icon: SidebarIcons.pencil) { [weak self] in self?.startRename(folder.id) },
            .separatorItem,
            MenuItemSpec(label: "Delete folder", icon: SidebarIcons.trash, danger: true) { [weak self] in self?.deleteFolder(folder.id) },
        ], at: pointOf(event))
    }

    // MARK: renaming in place

    func startRename(_ id: String) { quiet(); renaming = id; render() }
    func endRename() { renaming = nil; render() }

    // MARK: hover cards and tooltips (Rail.jsx flyout and tip)

    func holdFly() { flyTimer?.invalidate(); flyTimer = nil }
    func leaveFly() {
        holdFly()
        guard flyout != nil else { return }
        flyTimer = Timer.scheduledTimer(withTimeInterval: context.timing.close, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // the pointer crossed onto the card: it stays while it is there (the card's mouseenter held it)
                if self.flyCard.isOpen && self.flyCard.window.frame.contains(NSEvent.mouseLocation) { self.leaveFly() } else { self.hideFlyout() }
            }
        }
    }
    func wantFly(_ id: String, element: NSView) {
        if flyout?.id == id { holdFly(); return }
        holdFly()
        let wait = flyout != nil ? context.timing.switchTo : context.timing.open
        flyTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, element.window != nil else { return }
                self.flyout = (id, self.anchorOf(element))
                self.drawFlyout()
            }
        }
    }
    func hideFlyout() { holdFly(); let had = flyout != nil; flyout = nil; flyCard.close(); if had { installEscape() } }
    private func drawFlyout() {
        guard let fly = flyout, tree.has(fly.id), let window, let content = window.contentView else { flyCard.close(); return }
        let view = ProjectFlyoutView(id: fly.id, tree: tree, counts: counts, hereId: input.hereId, onGo: { [weak self] id in self?.go(id) })
            .onHover { [weak self] inside in if !inside { self?.leaveFly() } }
        let probe = NSHostingView(rootView: view)
        let size = CGSize(width: 270, height: min(440, probe.fittingSize.height))
        let spot = Placement.place(PlaceAnchor(fly.anchor), size: size, view: content.bounds.size, gap: 6, side: .right)
        flyCard.show(in: window, origin: CGPoint(x: spot.left, y: spot.top), width: 270, maxHeight: spot.maxHeight ?? 440, view)
        installEscape()
    }

    func showTip(_ element: NSView?, kind: String = "label", n: Int = 0, label: String = "") {
        guard let element else { tipTimer?.invalidate(); tipFor = nil; let had = tip != nil; tip = nil; tipCard.close(); if had { installEscape() }; return }
        if tipFor === element { return }
        tipTimer?.invalidate()
        tipFor = element
        tip = nil; tipCard.close()
        tipTimer = Timer.scheduledTimer(withTimeInterval: context.timing.open, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, element.window != nil, self.tipFor === element else { return }
                self.tip = (FloatingPanel.anchorRect(of: element), kind, n, label)
                self.drawTip()
            }
        }
    }
    private func drawTip() {
        guard let tip, let window, let content = window.contentView else { tipCard.close(); return }
        let origin = TooltipTiming.spot(for: tip.rect, view: content.bounds.size)
        let face = tip.kind == "shortcut" ? AnyView(TooltipFace("Toggle project with Ctrl + \(tip.n)", key: "⌃\(tip.n)")) : AnyView(TooltipFace(tip.label))
        tipCard.show(in: window, origin: origin, width: nil, face.driveID("sb-tip=\(tip.kind)"))
        installEscape()
    }
    func labelTip(_ element: NSView, _ label: String) { showTip(element, kind: "label", label: label) }

    /// The hover things put away (Rail.jsx quiet).
    func quiet() { holdFly(); hideFlyout(); showTip(nil) }

    /// Escape with a hover card, a tooltip or a peek showing puts it away and goes no further: it never leaves the project.
    func installEscape() {
        let hovering = flyout != nil || tip != nil || peek.isShowing
        if hovering && escMonitor == nil && !input.hidden {
            escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, event.keyCode == 53, self.flyout != nil || self.tip != nil || self.peek.isShowing else { return event }
                self.quiet(); self.peek.drop()
                return nil
            }
        } else if !hovering, let m = escMonitor { NSEvent.removeMonitor(m); escMonitor = nil }
    }

    // MARK: the tour (Rail.jsx tourStep)

    func tourChanged(_ step: Int?) {
        if step == 0 {
            DispatchQueue.main.async { [weak self] in
                guard let self, let row = self.rows["sb-trigger=library"] else { return }
                self.peek.drop(); self.hideFlyout()
                self.open(Panel(kind: "library", anchor: self.anchorOf(row), chip: "all"))
                self.tourOpened = true
            }
            return
        }
        if tourOpened { tourOpened = false; if panel?.kind == "library" { close() } }
        if step != nil && !(opened["section:sources"] ?? true) { opened["section:sources"] = true; context.storage.setOpened(opened) }
    }

    func tourRects(_ step: Int) -> [CGRect] {
        func rect(_ ids: [String]) -> CGRect? {
            let frames = ids.compactMap { rows[$0] }.filter { $0.window != nil && !$0.isHidden }.map { FloatingPanel.anchorRect(of: $0) }
            guard var box = frames.first else { return nil }
            for f in frames.dropFirst() { box = box.union(f) }
            // clipped to the sidebar's scrolling part
            let clip = FloatingPanel.anchorRect(of: root.scroll)
            box = CGRect(x: box.minX, y: max(box.minY, clip.minY), width: box.width, height: min(box.maxY, clip.maxY) - max(box.minY, clip.minY))
            guard box.height >= 4 else { return nil }
            return box.insetBy(dx: -5, dy: -5).integral
        }
        switch step {
        case 0:
            var out: [CGRect] = []
            if let r = rect(["sb-trigger=library"]) { out.append(r) }
            if panel?.kind == "library", let spot = panelHost.spot { out.append(CGRect(x: spot.left, y: spot.top, width: panelHost.cardSize.width, height: panelHost.cardSize.height).insetBy(dx: -5, dy: -5)) }
            return out
        case 1: return [rect(["sb-head=sources", "sb-folder-group=project"])].compactMap { $0 }
        case 2: return [rect(rows.keys.filter { $0.hasPrefix("sb-folder-group=") && $0 != "sb-folder-group=project" }.sorted() + ["sb-create-folder"])].compactMap { $0 }
        default: return []
        }
    }

    // MARK: drops

    func drop(_ info: NSDraggingInfo) -> Bool {
        let pb = info.draggingPasteboard
        guard !SidebarDrag.carriesRows(pb) else { return false }
        var files: [Drop.Item] = []
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] { files = urls.map { .path($0.path) } }
        let uri = (pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL])?.filter { !$0.isFileURL }.map(\.absoluteString).joined(separator: "\n") ?? pb.string(forType: .string)
        let items = Drop.readDrop(files: files, uriList: uri, html: pb.string(forType: .html))
        guard !items.isEmpty else { return false }
        Task { await context.actions.dropItems(items) }
        return true
    }
}

/// Finds a view by its accessibility identifier inside a window (the switch row of the project menu).
@MainActor
enum DriveLookup {
    static func view(_ id: String, in window: NSWindow) -> NSView? {
        guard let root = window.contentView else { return nil }
        func walk(_ v: NSView) -> NSView? {
            if v.accessibilityIdentifier() == id { return v }
            for sub in v.subviews { if let hit = walk(sub) { return hit } }
            return nil
        }
        return walk(root)
    }
}

extension CGPoint {
    @MainActor func contentIn(_ window: NSWindow?) -> CGPoint {
        guard let window else { return self }
        return SidebarViewController.contentPoint(self, in: window)
    }
}

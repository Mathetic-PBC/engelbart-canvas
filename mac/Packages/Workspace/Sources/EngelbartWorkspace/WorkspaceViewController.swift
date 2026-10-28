import AppKit
import SwiftUI
import EngelbartCore
import EngelbartDoc
import EngelbartUI
import EngelbartEditor
import EngelbartStage
import EngelbartTerminal
import EngelbartBuild
import EngelbartStore

/// The workspace screen (screens/Workspace.jsx): a header in three columns, then the sidebar, the document (and the one
/// opened beside it), and the right pane (the Stage or the terminal). The app's window shows one per project:
///
///     let screen = WorkspaceViewController(context)   // WorkspaceContext: the API, the tree, the library, the entry…
///     window.contentViewController = screen          // or embed `screen.view`
///     screen.update(tree:library:)                    // whenever the app reads the tree again (another window's change)
///
/// One view hierarchy decides what covers what (Electron's data-overlay / data-cover rules): popups are child panels
/// (EngelbartUI.FloatingPanel) above the Stage's WKWebView, PDFKit and the terminal; dialogs are views added last.
@MainActor
public final class WorkspaceViewController: NSViewController {
    public let model: WorkspaceModel
    let root = FillView()
    let header = HeaderView()
    let body = FillView()
    let railBox = FlippedView()
    let railEdge = SeparatorView(id: "rail-edge")
    let page = FillView()
    let column = NSScrollView()
    let columnDoc = FlippedView()
    let rightEdge = SeparatorView(id: "right-edge")
    let right = FillView()
    var panes: [DocPaneView] = []
    var hosts: [WorkspaceEditorHost] = []
    public private(set) var sidebar: WorkspaceSidebar?
    public private(set) var postIts: WorkspacePostIts?
    public private(set) var stage: StageController?
    public private(set) var terminal: TerminalPaneController?
    let stageHost: WorkspaceStageHost
    let terminalHost: WorkspaceTerminalHost
    var notePanel: FloatingPanel?
    var notePicker: NotePickerModel?
    var buildPanel: FloatingPanel?
    var reviewView: NSView?
    var rejectView: NSView?
    var quickPanel: FloatingPanel?
    let copyButton: FlatButton
    let buildButton: FlatButton
    let clearButton: FlatButton
    let restoreButton: FlatButton
    var monitors: [Any] = []
    lazy var sides = SideTracker<NSView>(sideOf: { [weak self] v in self?.sideOf(v) }, paneOf: { [weak self] v in self?.paneOf(v) })
    var shownKeys: [Int: String] = [:]
    var focusedTitle = false

    public init(_ context: WorkspaceContext) {
        model = WorkspaceModel(context)
        stageHost = WorkspaceStageHost(model: model)
        terminalHost = WorkspaceTerminalHost(model: model)
        let foot = Fonts.sans(15)
        copyButton = FlatButton(.text("Copy", font: foot), color: Look.fnt, hoverColor: Look.ink, id: "copy-doc")
        buildButton = FlatButton(.text("Build", font: foot), color: Look.fnt, hoverColor: Look.ink, id: "build-doc", tip: "Hand this project to a coding agent")
        clearButton = FlatButton(.text("Clear", font: foot), color: Look.fnt, hoverColor: Look.ink, id: "clear-doc", tip: "Archive this document and start it blank")
        restoreButton = FlatButton(.text("Restore", font: foot), color: Look.fnt, hoverColor: Look.ink, id: "restore-doc", tip: "Make this version the workspace's document again")
        for b in [copyButton, buildButton, clearButton, restoreButton] { b.padding = NSEdgeInsets(top: 3, left: 6, bottom: 3, right: 6); b.radius = 5 }
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    public override func loadView() {
        root.fill = .white
        root.setAccessibilityIdentifier("screen=workspace")
        view = root
        body.fill = Look.ground
        page.fill = .white
        right.fill = .white
        column.drawsBackground = false
        column.hasHorizontalScroller = true
        column.autohidesScrollers = true
        column.hasVerticalScroller = false
        column.documentView = columnDoc
        column.setAccessibilityIdentifier("doc-column")
        page.addSubview(column)
        page.addSubview(rightEdge)
        page.addSubview(right)
        page.setAccessibilityIdentifier("page-card")
        body.addSubview(railBox)
        body.addSubview(railEdge)
        body.addSubview(page)
        root.addSubview(body)
        root.addSubview(header)
        right.setAccessibilityIdentifier("right-pane")
        railEdge.color = nil
        rightEdge.color = Look.line
        wire()
        makeChildren()
    }

    /// The tree and the library read again (App.jsx reload, another window's change).
    public func update(tree: ProjectTree, library: [LibraryRow]) { model.update(tree: tree, library: library) }
    /// Connect your library's notes for Agents (the app adapts ImportUI's connectInbox + dockLine).
    public func setConnectNotes(_ notes: [ConnectNote]) { model.setConnectNotes(notes) }
    /// The import's "Open library" and whether a popup pauses the tour.
    public func setTour(_ request: TourRequest?, paused: Bool) { model.tourPaused = paused; model.takeTourRequest(request) }

    func wire() {
        model.onChange = { [weak self] in self?.render() }
        model.editors = { [weak self] in self?.panes.map { $0.editor as EditorHandle? } ?? [] }
        model.windowIsKey = { [weak self] in self?.view.window?.isKeyWindow ?? false }
        model.showTerminalSession = { [weak self] id in self?.terminal?.show(sessionId: id) }
        stageHost.keysToDocNow = { [weak self] in self?.keysToDoc() ?? false }
        terminalHost.keysToDocNow = { [weak self] in self?.keysToDoc() ?? false }
        header.onToggle = { [weak self] in self?.model.toggleRail() }
        header.onPlus = { [weak self] in self?.toggleNotePicker() }
        header.onFull = { [weak self] in self?.model.toggleDocFull() }
        header.onMode = { [weak self] m in self?.model.rightMode = m }
        header.tabs.onSelect = { [weak self] id in self?.model.setActiveTab(id) }
        header.tabs.onClose = { [weak self] id in self?.model.closeTab(id) }
        header.tabs.onMove = { [weak self] id, over in self?.model.moveTab(id, over: over) }
        railEdge.onDown = { [weak self] in self?.model.railDragBegan() }
        railEdge.onDrag = { [weak self] x in
            guard let self else { return }
            let left = self.body.convert(NSPoint.zero, to: nil).x
            self.model.railWidth = WorkspaceLayout.railDragged(x: x - left, viewWidth: self.model.viewWidth, right: self.model.layout.right)
        }
        railEdge.onReset = { [weak self] in self?.model.railWidth = WorkspaceLayout.railDefault }
        rightEdge.onDrag = { [weak self] x in
            guard let self else { return }
            let bodyRight = self.body.convert(NSPoint(x: self.body.bounds.maxX, y: 0), to: nil).x
            self.model.rightWidth = WorkspaceLayout.rightDragged(x: x, bodyRight: bodyRight, rightRoom: self.model.layout.rightRoom)
        }
        rightEdge.onReset = { [weak self] in self?.model.rightWidth = nil }
        copyButton.action = { [weak self] in Task { @MainActor in await self?.model.copyDoc() } }
        buildButton.action = { [weak self] in self?.toggleBuildPanel() }
        clearButton.action = { [weak self] in Task { @MainActor in await self?.model.clearDoc() } }
        restoreButton.action = { [weak self] in
            guard let self, let file = self.model.paneDocs[0].archive else { return }
            Task { @MainActor in await self.model.restoreVersion(file) }
        }
    }

    func makeChildren() {
        let ctx = model.ctx
        if let make = ctx.makeSidebar {
            let s = make(model)
            sidebar = s
            railBox.addSubview(s.view)
            header.clock = s.makeRecentPages()
        }
        let stage = ctx.makeStage?(stageHost) ?? StageController(host: stageHost, pageMarks: ctx.stagePageMarks)
        self.stage = stage
        model.stage = stage
        addChild(stage)
        right.addSubview(stage.view)
        stage.onFull = { [weak self] in self?.model.toggleStageFull() }
        let terminal: TerminalPaneController? = ctx.makeTerminal.map { $0(terminalHost) } ?? TerminalPaneController(host: terminalHost)
        if let terminal {
            self.terminal = terminal
            addChild(terminal)
            right.addSubview(terminal.view)
        }
        if let make = ctx.makePostIts {
            let p = make(model)
            postIts = p
            if let overlay = p.overlay { root.addSubview(overlay) }
        }
    }

    public override func viewDidAppear() {
        super.viewDidAppear()
        installMonitors()
    }
    public override func viewWillDisappear() {
        super.viewWillDisappear()
        removeMonitors()
    }

    var started = false
    public override func viewDidLoad() {
        super.viewDidLoad()
        if !started { started = true; model.start() }
        render()
    }

    /// Leaving the project: everything waiting is saved, the Stage keeps its tabs and closes its pages.
    public func close() {
        model.teardown()
        removeMonitors()
        stage?.teardown()
        for p in panes { p.editor.flush() }
        notePanel?.close(); buildPanel?.close(); quickPanel?.close()
    }

    // MARK: layout

    public override func viewDidLayout() {
        super.viewDidLayout()
        model.viewWidth = root.bounds.width
        layoutAll()
    }

    func layoutAll() {
        let w = root.bounds.width, h = root.bounds.height
        let l = model.layout
        let th = WorkspaceLayout.titleBar
        header.frame = CGRect(x: 0, y: 0, width: w, height: th)
        body.frame = CGRect(x: 0, y: th, width: w, height: max(0, h - th))
        let bh = body.bounds.height
        railBox.isHidden = !l.railShown
        railEdge.isHidden = !l.railShown
        railBox.frame = CGRect(x: 0, y: 0, width: l.railShown ? l.rail : 0, height: bh)
        sidebar?.view.frame = railBox.bounds
        railEdge.frame = CGRect(x: l.rail - 6 + 0.5, y: 0, width: 13, height: bh)
        let pageX = l.railSpace
        page.frame = CGRect(x: pageX, y: 0, width: max(0, w - pageX), height: bh)
        page.corners = l.railShown ? (12, 0, 0, 12) : (0, 0, 0, 0)
        page.ring = l.railShown ? NSColor.black.withAlphaComponent(0.045) : nil
        let pw = page.bounds.width
        let full = model.stageFull, docFull = model.docFull
        let rightW = docFull ? 0 : l.paneWidth
        right.isHidden = docFull
        right.frame = CGRect(x: pw - rightW, y: 0, width: rightW, height: bh)
        stage?.view.frame = right.bounds
        terminal?.view.frame = right.bounds
        rightEdge.isHidden = full || docFull
        let colW = full ? 0 : (docFull ? pw : max(WorkspaceLayout.docMin, pw - rightW - 1))
        column.isHidden = full
        column.frame = CGRect(x: 0, y: 0, width: colW, height: bh)
        rightEdge.frame = CGRect(x: colW - 6, y: 0, width: 13, height: bh)
        layoutPanes()
        layoutOverlays()
        header.needsLayout = true
    }

    func layoutPanes() {
        let colW = column.contentSize.width, colH = column.bounds.height
        let n = panes.count
        let each = n > 1 ? max(WorkspaceLayout.paneMin, (colW / CGFloat(n)).rounded(.down)) : colW
        columnDoc.frame = CGRect(x: 0, y: 0, width: max(colW, each * CGFloat(n)), height: colH)
        for (i, p) in panes.enumerated() { p.frame = CGRect(x: each * CGFloat(i), y: 0, width: each, height: colH) }
        if let at = model.revealPane {
            model.revealPane = nil
            if columnDoc.frame.width > colW {
                let x = at > 0 ? columnDoc.frame.width - colW : 0
                NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.25; column.contentView.animator().setBoundsOrigin(NSPoint(x: x, y: 0)) }
                column.reflectScrolledClipView(column.contentView)
            }
        }
    }

    func layoutOverlays() {
        postIts?.overlay?.frame = root.bounds
        if let review = reviewView {
            let aside = model.stageFull || model.docFull ? 0 : model.layout.paneWidth + 1
            review.frame = CGRect(x: 0, y: 0, width: root.bounds.width - aside, height: root.bounds.height)
        }
        rejectView?.frame = root.bounds
    }

    // MARK: drawing the model

    var rendering = false
    func render() {
        guard isViewLoaded, !rendering else { return }
        rendering = true
        defer { rendering = false }
        let l = model.layout
        header.railShown = l.railShown
        header.railWidth = l.rail
        header.paneWidth = l.paneWidth
        header.stageFull = model.stageFull
        header.docFull = model.docFull
        header.fullScreenWindow = view.window?.styleMask.contains(.fullScreen) ?? false
        header.controlsRoom = model.docFull ? model.ctx.controlsRoom() : 0
        header.hasTopic = model.topic != nil
        header.mode = model.rightMode
        header.plus.pressedOn = model.notePlus
        header.tabs.update(tabs: WorkspaceTabs.shown(model.tabs, projectName: model.project.name), active: model.activeTab, wsName: model.topic?.name ?? "")
        header.needsLayout = true
        root.alphaValue = 1
        renderPanes()
        renderRight()
        sidebar?.update(model.sidebarState())
        postIts?.update(model.postItsState())
        renderOverlays()
        model.ctx.onSidebarGear(model.active && l.railShown)
        layoutAll()
        if model.wantTitleFocus, let p = panes.first, p.showsEditor { model.wantTitleFocus = false; p.focusTitle() }
    }

    func renderPanes() {
        let docs = model.paneDocs
        while panes.count < docs.count {
            let i = panes.count
            let host = WorkspaceEditorHost(model: model, pane: i)
            let p = DocPaneView(index: i, onClose: i > 0 ? { [weak self] in self?.model.closeBeside(i) } : nil)
            p.editor.host = host
            hosts.append(host)
            panes.append(p)
            columnDoc.addSubview(p)
        }
        while panes.count > docs.count {
            let p = panes.removeLast(); hosts.removeLast()
            p.editor.flush()
            p.removeFromSuperview()
            shownKeys[panes.count] = nil
        }
        let asks = model.askProgress, builds = model.buildStates, models = model.questionModels
        for (i, doc) in docs.enumerated() {
            let p = panes[i]
            let pane = i > 0 ? model.beside[i - 1] : nil
            let next = i < model.beside.count ? model.beside[i] : nil
            let title: String
            if let pane { title = pane.kind == .workspace ? (model.index[pane.id]?.node.name ?? pane.title) : (model.notesById[pane.id]?.name ?? pane.title) }
            else { title = model.docTitle }
            p.setTitle(title, readOnly: doc.archive != nil)
            p.onRename = { [weak self] name in
                guard let self else { return }
                Task { @MainActor in
                    if let pane { if pane.kind == .workspace { await self.model.renameWorkspaceBeside(pane.id, name) } else { await self.model.renameNoteDoc(pane.id, name) } }
                    else { await self.model.renameDoc(name) }
                }
            }
            p.conflict = doc.key.map { model.conflicts[$0] != nil } ?? false
            p.onKeepMine = { [weak self] in if let k = doc.key { self?.model.keepMine(k) } }
            p.onTakeTheirs = { [weak self] in if let k = doc.key { self?.model.takeTheirs(k) } }
            let text = doc.key.flatMap { model.docs[$0] }
            p.showsEditor = text != nil
            p.emptyView = i == 0 && model.topics.isEmpty ? emptyProjectView() : nil
            let e = p.editor
            e.readOnly = doc.archive != nil
            e.autoCollapse = true
            e.viewScope = i == 0 ? model.topicId : nil
            e.besideLink = next.flatMap { $0.kind != .workspace ? $0.link : nil }
            e.besideWorkspace = next.flatMap { $0.kind == .workspace ? $0.id : nil }
            e.zoteroFinding = model.zoteroFinding
            e.zoteroWaiting = model.zoteroWaiting
            let walk = i == 0 && model.walkShown
            e.emptyHint = walk && doc.archive == nil ? Walkthrough.emptyHint : nil
            if i == 0 { p.walkCard = walk ? (p.walkCard ?? sidebar?.makeWalkCard()) : nil }
            if let key = doc.key, let text {
                if shownKeys[i] != key { shownKeys[i] = key; e.setDocument(key: key, text: text) }
                else if e.core.text != text { e.setText(text) }
            }
            e.setModels(models)
            e.setAsks(asks)
            e.setBuilds(builds)
            hosts[i].refreshCards()
            p.hasFooter = i == 0
            if i == 0 { p.setFooter(footerButtons(doc)) }
        }
    }

    func footerButtons(_ doc: PaneDoc) -> [FlatButton] {
        if doc.archive != nil { return [restoreButton] }
        let copied = model.copied
        copyButton.face = .text(copied.map { WorkspaceText.copiedLabel(files: $0.files, missing: $0.missing) } ?? "Copy", font: Fonts.sans(15))
        copyButton.color = copied != nil ? Look.ink : Look.fnt
        copyButton.toolTip = WorkspaceText.copyTitle(workspaceDoc: doc.workspaceId != nil, projectPage: model.activeTab == WorkspaceTabs.project)
        copyButton.invalidateIntrinsicContentSize()
        if doc.workspaceId != nil && copied == nil { buildButton.pressedOn = model.buildDialog != nil; return [copyButton, buildButton, clearButton] }
        return [copyButton]
    }

    func emptyProjectView() -> NSView {
        let box = NSStackView()
        box.orientation = .vertical
        box.alignment = .centerX
        box.spacing = 14
        let words = NSTextField(wrappingLabelWithString: WorkspaceText.emptyProject(model.project.name))
        words.font = Fonts.sans(13); words.textColor = Look.fnt; words.alignment = .center
        words.preferredMaxLayoutWidth = 360
        let add = FlatButton(.text("+ Project", font: Fonts.sans(12.5, weight: 500)), color: Look.ink, hoverFill: nil, radius: 8, id: "add-project") { [weak self] in self?.model.addTopic() }
        add.padding = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        add.wantsLayer = true
        add.layer?.borderColor = Look.line.cgColor; add.layer?.borderWidth = 1; add.layer?.cornerRadius = 8
        box.addArrangedSubview(words)
        box.addArrangedSubview(add)
        return box
    }

    func renderRight() {
        stage?.visible = model.rightMode == "stage" && !model.docFull
        stage?.full = model.stageFull
        stage?.save = model.stageSave
        stage?.pendingAsks = model.pendingPaperAsks
        stageHost.pushPending(model.pendingPaperAsks)
        terminal?.visible = model.rightMode == "terminal" && !model.docFull
        stage?.view.isHidden = model.rightMode != "stage"
        terminal?.view.isHidden = model.rightMode != "terminal"
    }

    // MARK: overlays: the note picker, the Build panel, Review, Reject, a quick task

    func toggleNotePicker() {
        if notePanel != nil { closeNotePicker(); return }
        guard let window = view.window, model.topic != nil else { return }
        let picker = NotePickerModel(library: { [weak self] in self?.model.library ?? [] }, openIds: { [weak self] in self?.model.tabs.map(\.id) ?? [] },
                                     inRail: { [weak self] in self?.model.inRail($0) ?? false },
                                     onPick: { [weak self] row in self?.model.openTab(row.id, title: row.name) },
                                     onNew: { [weak self] name in _ = try await self?.model.makeNote(name, open: true) },
                                     onClose: { [weak self] in self?.closeNotePicker() },
                                     onError: { [weak self] e in self?.model.report(e) })
        let panel = FloatingPanel()
        panel.onClose = { [weak self] in self?.notePanel = nil; self?.notePicker = nil; self?.model.notePlus = false; self?.model.changed() }
        panel.show(in: window, anchor: FloatingPanel.anchorRect(of: header.plus), options: FloatingOptions(side: .below, gap: 6, cap: 420, width: 320, radius: 8, rise: 0.16)) {
            NotePickerView(model: picker)
        }
        notePanel = panel
        notePicker = picker
        model.notePlus = true
        model.changed()
    }
    func closeNotePicker() {
        let p = notePanel
        notePanel = nil; notePicker = nil
        p?.close()
        model.notePlus = false
        model.changed()
    }
    public var notePickerOpen: Bool { notePanel != nil }

    func toggleBuildPanel() {
        guard let window = view.window else { return }
        if buildPanel != nil { buildPanel?.close(); buildPanel = nil; model.closeBuildDialog(); return }
        guard let actions = model.ctx.buildActions, let topic = model.topic else { return }
        let panelModel = BuildPanelModel(projectId: model.projectId, workspaceId: topic.id, title: topic.name, actions: actions) { [weak self] start in
            guard let self else { return }
            var input: [String: JSONValue] = ["provider": .string(start.provider), "model": .string(start.model), "effort": .string(start.effort),
                                              "attach": .array(start.attach.map { .string($0) })]
            if !start.target.isNull { input["target"] = start.target }
            try await self.model.startBuild(.object(input), clear: start.clear)
            self.buildPanel?.close(); self.buildPanel = nil
        }
        let library = model.library.map { PanelLibraryItem(id: $0.id, name: $0.name, type: $0.type, tags: $0.tags) }
        let panel = FloatingPanel()
        panel.onClose = { [weak self] in self?.buildPanel = nil; self?.model.closeBuildDialog() }
        let anchor = FloatingPanel.anchorRect(of: buildButton)
        panel.show(in: window, anchor: anchor, options: FloatingOptions(side: .below, gap: 6, card: false)) {
            BuildPanelView(model: panelModel, library: library) { [weak self] in self?.buildPanel?.close(); self?.buildPanel = nil; self?.model.closeBuildDialog() }
        }
        buildPanel = panel
        model.toggleBuildDialog(anchor: anchor)
    }

    func renderOverlays() {
        // Review (Preview's fallback): over everything but the right pane
        if let r = model.review {
            let view = BuildReviewView(title: r.title, review: r.review, error: r.error, task: model.builds[r.id], onOpen: { [weak self] name in
                Task { @MainActor in await self?.model.onBuildAction(r.id, "runshow", name: name) }
            }, onClose: { [weak self] in self?.model.closeReview() })
            if let host = reviewView as? NSHostingView<BuildReviewView> { host.rootView = view } else {
                reviewView?.removeFromSuperview()
                let host = NSHostingView(rootView: view)
                host.setAccessibilityIdentifier("build-review")
                root.addSubview(host); reviewView = host
            }
        } else if let v = reviewView { v.removeFromSuperview(); reviewView = nil }
        // Reject asks to confirm, then discards
        if let r = model.rejecting {
            if rejectView == nil {
                let host = NSHostingView(rootView: BuildRejectView(title: r.title, onConfirm: { [weak self] in _ = await self?.model.onBuildAction(r.id, "discard") }, onClose: { [weak self] in self?.model.closeReject() }))
                host.setAccessibilityIdentifier("build-reject")
                root.addSubview(host); rejectView = host
            }
        } else if let v = rejectView { v.removeFromSuperview(); rejectView = nil }
    }

    // MARK: keys (Workspace.jsx's window keydown listeners)

    /// Whether the middle canvas has ⌘T, ⌘W and ⌘F now (model/key-side.js): it was clicked last, or it is full screen.
    public func keysToDoc() -> Bool { KeySide.docHasKeys(sides.side.rawValue, docShown: model.active && !model.stageFull, docFull: model.docFull) }

    func sideOf(_ v: NSView?) -> SideTracker<NSView>.Side? {
        guard let v else { return nil }
        if v.isDescendant(of: column) { return .doc }
        if let s = stage?.view, v.isDescendant(of: s) { return .stage }
        if let t = terminal?.view, v.isDescendant(of: t) { return .terminal }
        return nil
    }
    func paneOf(_ v: NSView?) -> Int? { guard let v else { return nil }; return panes.firstIndex { v.isDescendant(of: $0) } }
    var firstResponderView: NSView? {
        let r = view.window?.firstResponder
        if let t = r as? NSTextView, t.isFieldEditor, let d = t.delegate as? NSView { return d }
        return r as? NSView
    }
    var inTerminal: Bool { guard let t = terminal?.view, let f = firstResponderView else { return false }; return f.isDescendant(of: t) }

    func installMonitors() {
        removeMonitors()
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            nonisolated(unsafe) let event = e
            let taken = MainActor.assumeIsolated { self?.handleKey(event) ?? false }
            return taken ? nil : e
        } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
            nonisolated(unsafe) let event = e
            MainActor.assumeIsolated { self?.pressed(event) }
            return e
        } as Any)
        let hub = model.ctx.hub
        pageToken = hub.on(WorkspaceEvents.browserFocused) { [weak self] _ in MainActor.assumeIsolated { if self?.view.window?.isKeyWindow == true { self?.sides.page() } } }
        shortcutToken = hub.on(WorkspaceEvents.browserShortcut) { [weak self] e in MainActor.assumeIsolated {
            guard let self, self.view.window?.isKeyWindow == true, e["tab"] == nil || e["tab"]?.isNull == true, self.keysToDoc(), let name = e["name"]?.string else { return }
            _ = self.menuFind(name)
        } }
    }
    /// A press anywhere in the window: the side it was in has ⌘T, ⌘W and ⌘F now.
    func pressed(_ e: NSEvent) {
        guard e.window === view.window, let hit = view.window?.contentView?.hitTest(e.locationInWindow) else { return }
        sides.pressed(hit)
    }
    var pageToken: EventHub.Token?
    var shortcutToken: EventHub.Token?
    func removeMonitors() {
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        if let t = pageToken { model.ctx.hub.off(t) }; pageToken = nil
        if let t = shortcutToken { model.ctx.hub.off(t) }; shortcutToken = nil
    }

    /// The Edit menu's Find items, when the document has the keys (the app's ActionRouter calls this; false passes it on).
    @discardableResult
    public func menuFind(_ name: String) -> Bool {
        guard keysToDoc() else { return false }
        if name == "find" { docFind(); return true }
        if (name == "find-next" || name == "find-previous"), let f = model.docFind { editorAt(f.pane)?.findStep(name == "find-next" ? 1 : -1); return true }
        return false
    }

    func editorAt(_ i: Int) -> DocEditorView? { i < panes.count ? panes[i].editor : nil }

    func docFind() {
        let at = max(0, min(sides.pane, model.paneDocs.count - 1))
        guard let e = editorAt(at) else { return }
        let back = e.caretNow()
        model.docFind = (at, (model.docFind?.focus ?? 0) + 1, back ?? (model.docFind?.pane == at ? model.docFind?.back : nil))
        e.openFind()
    }

    /// → whether the key was taken (not passed on).
    func handleKey(_ e: NSEvent) -> Bool {
        guard let w = view.window, e.windowNumber == w.windowNumber, model.active else { return false }
        sides.focused(firstResponderView)
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let cmd = f.contains(.command), ctrl = f.contains(.control), alt = f.contains(.option), shift = f.contains(.shift)
        let key = (e.charactersIgnoringModifiers ?? "").lowercased()
        // ⌘J, wherever the keyboard is (capture phase: before the editor or a terminal).
        if cmd && !ctrl && !alt && !shift && key == "j" { if !e.isARepeat { model.goNextAgent() }; return true }
        // Ctrl+1–9: this project's top-level workspaces, anywhere.
        if ctrl && !cmd && !alt && !shift, let n = Int(key), (1...9).contains(n) { if !e.isARepeat { _ = model.goShortcut(n) }; return true }
        // ⌘\ (or Ctrl+\): the sidebar.
        if (cmd || ctrl) && !alt && !shift && key == "\\" { if !e.isARepeat { model.toggleRail() }; return true }
        // ⌘T / ⌘W / ⌘F / ⌘G in the middle canvas when it has them.
        if cmd && !ctrl && !alt && keysToDoc() {
            if key == "g" { if let fd = model.docFind { editorAt(fd.pane)?.findStep(shift ? -1 : 1); return true }; return false }
            if !shift {
                if key == "t" { if notePanel == nil { toggleNotePicker() }; return true }
                if key == "w" {
                    switch KeySide.docClose(tabs: model.tabs.map(\.id), active: model.activeTab, pane: sides.pane, beside: model.beside.count) {
                    case .pane(let i)?: model.closeBeside(i)
                    case .tab(let id)?: model.closeTab(id)
                    case nil: break
                    }
                    return true
                }
                if key == "f" { docFind(); return true }
            }
        }
        // The Stage's own (⌘T, ⌘W, ⌘F, ⌘G) when it has them.
        if let stage, stage.handleKey(e, inTerminal: inTerminal) { return true }
        // ⌘1–9: the tabs of the side clicked last (not inside the terminal).
        if cmd && !ctrl, !inTerminal, let n = Int(e.charactersIgnoringModifiers ?? ""), (1...9).contains(n) {
            if sides.side == .terminal && model.rightMode == "terminal" { return false } // the Terminal's own tabs
            if sides.side == .stage && model.rightMode == "stage", let stage { _ = stage.tabAt(n - 1); return true }
            if n - 1 < model.tabs.count { model.setActiveTab(model.tabs[n - 1].id); return true }
            return false
        }
        if e.keyCode == 53 { return escape() }
        return false
    }

    /// Escape (Workspace.jsx): in the document's full screen, what had it goes first, then the full screen; never closes
    /// the workspace from there. Elsewhere, unused, outside an editor, a terminal or a field: all projects.
    func escape() -> Bool {
        let f = firstResponderView
        if model.docFull {
            if notePanel != nil { closeNotePicker(); return true }
            if panes.contains(where: { $0.editor.shutMenus() }) { return true }
            if f is NSTextField || (f is NSTextView && !(f?.isDescendant(of: column) ?? false)) { view.window?.makeFirstResponder(nil); return true }
            if let tv = f as? NSTextView, panes.contains(where: { tv.isDescendant(of: $0.editor) }), panes.contains(where: { $0.editor.isActive }) { return false }
            model.leaveDocFull()
            return true
        }
        let pane = f.flatMap { v in panes.first { v.isDescendant(of: $0) } } ?? panes.first
        if let e = pane?.editor, e.isActive { return false }
        if inTerminal { return false }
        if f is NSTextField || f is NSTextView { return false }
        model.ctx.onClose()
        return true
    }
}

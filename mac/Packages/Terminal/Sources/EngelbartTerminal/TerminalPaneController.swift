import AppKit
import EngelbartCore
import EngelbartUI

// Port of src/renderer/terminal/TerminalPane.jsx (design 2026-09-17, chat-style per Hudson). One rule decides where
// typing goes: while the shell is idle you type in the "Run commands" box at the bottom and the transcript does not take
// keys; while a program runs — a quick command, an arrow-key menu, Claude Code or Codex, however it was started — the
// keyboard belongs to the transcript, as in any terminal, and the box steps aside until the program ends. The shell tells
// the pane which state it is in through the marks the zsh wrappers emit (ShellRC.swift); they also keep the directory
// chip true. Every tab is a real PTY (SessionManager).

@MainActor
public final class TerminalPaneController: NSViewController, NSTextFieldDelegate {
    static let agents: [(id: String, label: String)] = [("shell", "Terminal"), ("claude", "Claude Code"), ("codex", "Codex")]
    static let label = ["shell": "Terminal", "claude": "Claude Code", "codex": "Codex", "sandbox": "Sandbox"]
    /// Commands that finish faster never move the keyboard.
    static let takeoverDelay = 0.2
    // Control characters by code (TerminalPane.jsx CTRL).
    static let ctrlC = "\u{3}", ctrlD = "\u{4}", ctrlL = "\u{c}"

    public weak var host: TerminalHost? { didSet { refresh() } }
    public let store: TerminalSessions

    /// Whether the pane shows (the right pane's Terminal mode). Hidden: its views are detached; sessions keep running.
    public var visible = true { didSet { if visible != oldValue { visibilityChanged() } } }

    enum Launching: Equatable { case provider(String), error(String) }

    // State (TerminalPane.jsx useState)
    var activeId: String?
    var launching: Launching?
    var history: [String] = []
    var histIdx: Int?
    var cwdOverride: [String: String] = [:] // session id → directory picked while no shell could cd
    var touched: Set<String> = []          // session id → a command was sent from the box
    var takeover = false                   // the running program has the keyboard
    private var takeoverTimer: DispatchWorkItem?
    private var takeoverKey: String?
    private var autoStarted = Set<String>()
    private var lastProjectCwd: String?
    private var focusKey: String?
    private var lockedId: String?

    // Views
    private let root = PaneRootView()
    let strip = TabStripView(frame: .zero)
    let stage = StageView()
    let footer = FooterView(frame: .zero)
    private var tabViews: [String: TabView] = [:]
    private var messageViews: [NSView] = []
    let agentMenu = AgentMenu()
    let card = TabCard()

    private var subscription: TerminalSessions.Subscription?
    private var keyMonitor: Any?
    private var scrollMonitor: Any?
    private var moveMonitor: Any?
    private var responderObservation: NSKeyValueObservation?
    private var showToken: EventHub.Token?
    private var windowObservers: [NSObjectProtocol] = []
    private var touchTimer: Timer?
    private var touching: String?

    /// `store`: the app's (`TerminalSessions.shared`) unless given.
    public init(store: TerminalSessions? = nil, host: TerminalHost? = nil) {
        self.store = store ?? .shared
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: lifecycle

    public override func loadView() {
        root.addSubview(strip)
        root.addSubview(stage)
        root.addSubview(footer)
        root.onLayout = { [weak self] in self?.layoutPane() }
        view = root
        strip.plus.action = { [weak self] in self?.launch(.shell, at: self?.projectCwd) }
        strip.agentButton.action = { [weak self] in self?.toggleMenu() }
        strip.fullButton.action = { [weak self] in self?.card.hide(); self?.host?.terminalToggleFullScreen() }
        footer.cwdChip.action = { [weak self] in self?.changeCwd() }
        footer.field.delegate = self
        footer.field.onFocus = { [weak self] in self?.boxFocused() }
        stage.onPress = { [weak self] in self?.stageClicked() }
        agentMenu.onClose = { [weak self] in self?.strip.menuOpen = false }
        subscription = store.subscribe { [weak self] in self?.refresh() }
        showToken = EventHub.shared.on("engelbart:show-terminal") { [weak self] payload in
            guard let id = payload["id"]?.string else { return }
            MainActor.assumeIsolated { self?.show(sessionId: id) }
        }
        // ↑ recalls real commands from the first keypress: the box is seeded from the shell's history file.
        let seeded = ShellHistory.read(homeDir: store.home)
        history = Array((seeded.filter { !history.contains($0) } + history).suffix(500))
        store.bootstrap()
        lastProjectCwd = host?.terminalProjectDirectory
        refresh()
    }

    public override func viewDidAppear() {
        super.viewDidAppear()
        installMonitors()
        refresh()
    }

    public override func viewWillDisappear() {
        super.viewWillDisappear()
        removeMonitors()
        agentMenu.close()
        card.hide()
    }

    public override func viewDidDisappear() {
        super.viewDidDisappear()
        // Detached: the views leave, the sessions and their PTYs stay; locks are released.
        unmountAll()
        for record in mySessions { record.view.locked = false }
        stopTouching()
    }

    deinit {
        MainActor.assumeIsolated {
            if let subscription { store.unsubscribe(subscription) }
            if let showToken { EventHub.shared.off(showToken) }
            removeMonitors()
            agentMenu.close()
            card.hide()
            touchTimer?.invalidate()
            for record in store.all where record.owner === self { record.owner = nil; record.view.removeFromSuperview() }
        }
    }

    // MARK: what the pane is looking at

    var projectId: String? { host?.terminalProjectId }

    /// The project's code directory; your home directory if a terminal is ever asked for without one.
    var projectCwd: String? { host?.terminalProjectDirectory ?? store.home }

    /// This project's sessions this pane holds (several windows: a session belongs to the pane it was opened from; one no
    /// pane holds, its window closed, comes to the next pane of its project).
    var mySessions: [TerminalRecord] {
        store.sessions(for: projectId).filter { $0.owner == nil || $0.owner === self }
    }

    var current: TerminalRecord? {
        let sessions = mySessions
        return sessions.first { $0.id == activeId } ?? sessions.first
    }

    var running: Bool { current?.isRunning == true }

    var now: TabDescription { current?.description ?? TabDescription(integrated: false, busy: false, agent: "shell", command: "", cwd: nil) }

    func cwdOf(_ record: TerminalRecord) -> String { record.description.cwd ?? cwdOverride[record.id] ?? record.snapshot.cwd }

    var currentCwd: String? { current.map(cwdOf) ?? projectCwd }

    var boxIsInput: Bool { running && now.integrated && !takeover } // the box owns typing; the transcript is locked
    var showBox: Bool { running && !takeover }
    var conversation: Bool { running && now.agent != "shell" } // Claude Code, Codex or a sandbox's shell: the program is the whole tab

    static func basename(_ value: String?) -> String {
        var text = value ?? "~"
        while text.hasSuffix("/") { text.removeLast() }
        let last = text.components(separatedBy: "/").last ?? ""
        return last.isEmpty ? "/" : last
    }

    static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: #"'\''"#) + "'" }

    // MARK: refresh (React's render + effects)

    func refresh() {
        guard isViewLoaded else { return }
        let sessions = mySessions
        for record in sessions where record.owner == nil { record.owner = self }
        if let activeId, !sessions.contains(where: { $0.id == activeId }) { self.activeId = nil }
        followProjectDirectory(sessions)
        autoStart(sessions)
        updateTakeover()
        updateLock()
        mount()
        render(sessions)
        updateFocus()
        updateTouch()
    }

    /// Bootstrap once; start one shell in the project directory when this project has none.
    private func autoStart(_ sessions: [TerminalRecord]) {
        guard let projectId, let cwd = host?.terminalProjectDirectory, sessions.isEmpty, !autoStarted.contains(projectId) else { return }
        autoStarted.insert(projectId)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            do {
                let record = try self.create(.shell, cwd: cwd)
                self.activeId = record.id
                self.refresh()
            } catch {
                self.autoStarted.remove(projectId)
                self.launching = .error("Shell could not be started: \(errorText(error))")
                self.refresh()
            }
        }
    }

    /// The project's code directory changed (chosen after the project opens, or re-chosen): terminals you have not used
    /// yet, still sitting in the old one, follow it.
    private func followProjectDirectory(_ sessions: [TerminalRecord]) {
        let cwd = host?.terminalProjectDirectory
        let previous = lastProjectCwd
        lastProjectCwd = cwd
        guard let cwd, let previous, previous != cwd else { return }
        for record in sessions {
            let shell = record.description
            let untouched = record.isRunning && shell.integrated && !shell.busy && !touched.contains(record.id)
            if untouched && (shell.cwd ?? record.snapshot.cwd) == previous { store.sendInput(record.id, "cd -- \(Self.shellQuote(cwd))\r") }
        }
    }

    /// Call when the host's project or directory changed (the pane also notices at its next refresh).
    public func projectDidChange() { refresh() }

    /// A running program takes the keyboard — after a beat, so `ls` does not make the focus jump. Claude Code and Codex
    /// take it at once: they are whole-screen programs, and the footer settles its height before they draw.
    private func updateTakeover() {
        let n = now
        let key = "\(n.busy)|\(n.integrated)|\(n.agent)|\(current?.id ?? "")"
        guard key != takeoverKey else { return }
        takeoverKey = key
        takeoverTimer?.cancel()
        takeoverTimer = nil
        if !n.busy { takeover = false; return }
        if !n.integrated || n.agent != "shell" { takeover = true; return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.takeover = true
            self.refresh()
        }
        takeoverTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.takeoverDelay, execute: work)
    }

    /// While the box is the input, the transcript is locked (keys and focus go to the box).
    private func updateLock() {
        let id = current?.id
        if let lockedId, lockedId != id { store.record(lockedId)?.view.locked = false }
        lockedId = id
        guard let record = current else { return }
        record.view.locked = boxIsInput
        record.view.onLockedPress = { [weak self] in self?.focusBox() }
        if boxIsInput, let window = view.window, window.firstResponder === record.view { focusBox() }
    }

    /// The current session's view goes into the stage; the others leave it.
    private func mount() {
        let currentId = current?.id
        for record in store.all where record.view.superview === stage && (record.id != currentId || !visible) {
            record.view.removeFromSuperview()
        }
        guard visible, let record = current else { return }
        if record.view.superview !== stage {
            stage.addSubview(record.view, positioned: .below, relativeTo: nil)
            layoutStage()
            store.fit(record.id)
        }
        stage.cursorIsText = !boxIsInput
    }

    private func unmountAll() {
        for record in store.all where record.view.superview === stage { record.view.removeFromSuperview() }
    }

    private func visibilityChanged() {
        root.isHidden = !visible
        if !visible { agentMenu.close(); card.hide() }
        focusKey = nil
        refresh()
    }

    /// Where typing goes, whenever what decides it changes: a program that has the keyboard gets it, else the box.
    private func updateFocus() {
        let key = "\(visible)|\(current?.id ?? "")|\(takeover)|\(showBox)"
        guard key != focusKey else { return }
        focusKey = key
        guard visible, current != nil, view.window != nil else { return }
        if takeover { focusTranscript() } else { focusBox() }
    }

    func focusBox() {
        guard let window = view.window, !footer.field.isHidden else { return }
        if window.firstResponder !== footer.field.currentEditor() { window.makeFirstResponder(footer.field) }
        if let editor = footer.field.currentEditor() { editor.selectedRange = NSRange(location: (footer.field.stringValue as NSString).length, length: 0) }
    }

    func focusTranscript() {
        guard let record = current, let window = view.window, record.view.superview != nil else { return }
        window.makeFirstResponder(record.view)
    }

    private func boxFocused() {}

    private func firstResponderChanged() {
        guard let window = view.window else { return }
        let responder = window.firstResponder
        for record in mySessions { record.view.setHasKeys(responder === record.view) }
        // While the pane's own box is the input the transcript never holds focus: it hands it to the box.
        if let record = current, record.view.locked, responder === record.view {
            DispatchQueue.main.async { [weak self] in self?.focusBox() }
        }
    }

    // MARK: drawing

    private func render(_ sessions: [TerminalRecord]) {
        let currentId = current?.id
        // Tabs
        var views: [TabView] = []
        for (i, record) in sessions.enumerated() {
            let on = record.id == currentId
            let next = i + 1 < sessions.count ? sessions[i + 1] : nil
            let sep = !on && next != nil && next!.id != currentId
            let alive = record.isRunning
            var title = record.snapshot.provider == .sandbox ? record.snapshot.title : Self.basename(cwdOf(record))
            if !alive { title += " · exited" + (record.snapshot.exitCode.map { " \($0)" } ?? "") }
            let last = sessions.count == 1
            let model = TabModel(id: record.id, title: title, on: on, separator: sep, closeLabel: last ? "Clear terminal" : "Close terminal",
                                 closeTooltip: last ? "Clear — the last terminal stays" : "Close")
            let tab = tabViews[record.id] ?? makeTab(model)
            tab.model = model
            tabViews[record.id] = tab
            views.append(tab)
        }
        for (id, tab) in tabViews where !sessions.contains(where: { $0.id == id }) { tab.removeFromSuperview(); tabViews[id] = nil }
        strip.setTabs(views)
        strip.agentLabel = Self.label[now.agent] ?? "Terminal"
        strip.showsFull = host?.terminalFullScreen != nil
        strip.fullScreen = host?.terminalFullScreen == true
        if card.shownId != nil && !sessions.contains(where: { $0.id == card.shownId }) { card.hide() }

        // Footer
        footer.agentLabel = Self.label[now.agent] ?? "Terminal"
        footer.cwd = currentCwd ?? "~"
        let sandbox = current?.snapshot.provider == .sandbox
        footer.cwdChip.enabled = current != nil && !sandbox
        footer.cwdChip.toolTip = sandbox ? "In the repository's sandbox" : "Change working directory…"
        if current == nil { footer.bottom = .empty }
        else if showBox { footer.bottom = .box }
        else if conversation { footer.bottom = .none } // a Claude Code or Codex conversation keeps no room for a box it never shows
        else { footer.bottom = .line(running ? "\u{a0}" : "this terminal has exited — press + for a new one") }

        renderMessages()
        layoutPane()
    }

    private func makeTab(_ model: TabModel) -> TabView {
        let tab = TabView(model: model)
        let id = model.id
        tab.onActivate = { [weak self] in self?.card.hide(); self?.activate(id) }
        tab.onClose = { [weak self] in self?.close(id) }
        tab.onHover = { [weak self, weak tab] inside in
            guard let self, let tab else { return }
            if inside {
                guard !tab.model.on else { return }
                self.card.enter(tab: tab, id: id) { [weak self] in
                    guard let self, let record = self.store.record(id) else { return ("Terminal", nil) }
                    return (Self.label[record.description.agent] ?? "Terminal", self.cwdOf(record))
                }
            } else {
                self.card.leave()
            }
        }
        return tab
    }

    /// The stage's text: no session yet, a launch that failed, the store's errors (each with ×).
    private func renderMessages() {
        messageViews.forEach { $0.removeFromSuperview() }
        messageViews = []
        let font = Fonts.mono(12.5)
        if current == nil {
            let text = !store.bootstrapComplete ? "starting…" : (host?.terminalProjectDirectory != nil ? "no terminal yet — press + or ⌘T" : "no project directory")
            messageViews.append(MessageLine(text: text, font: font, color: Palette.fnt, dismiss: nil))
        }
        if case .error(let message)? = launching {
            messageViews.append(MessageLine(text: "# \(message)", font: font, color: Palette.del, dismiss: nil))
        }
        for entry in store.errors {
            let at = entry.at
            messageViews.append(MessageLine(text: "# \(entry.message)", font: font, color: Palette.del, dismiss: { [weak self] in self?.store.dismissError(at: at) }))
        }
        // Deliberate departure (ledger #113): Electron drew these under the transcript (an absolute xterm view covers the
        // stage's text), so an error was only seen with no terminal open; here they sit above it.
        messageViews.forEach { stage.addSubview($0) }
    }

    private func layoutPane() {
        let bounds = root.bounds
        let footerH = footer.preferredHeight
        strip.frame = NSRect(x: 0, y: 0, width: bounds.width, height: TabStripView.height)
        footer.frame = NSRect(x: 0, y: bounds.height - footerH, width: bounds.width, height: footerH)
        stage.frame = NSRect(x: 0, y: TabStripView.height, width: bounds.width, height: max(0, bounds.height - TabStripView.height - footerH))
        layoutStage()
    }

    private func layoutStage() {
        // The view sits 10 from the top and 14 from the left, flush right and bottom: the stage's padding does not
        // reach it, and column 0 stays off the pane's edge and its resize handle (memory note 2026-09-20).
        let frame = NSRect(x: 14, y: 10, width: max(0, stage.bounds.width - 14), height: max(0, stage.bounds.height - 10))
        for case let transcript as TranscriptView in stage.subviews where transcript.frame != frame { transcript.frame = frame }
        var y: CGFloat = 10
        for line in messageViews {
            let h = 12.5 * 1.7
            line.frame = NSRect(x: 14, y: y, width: max(0, stage.bounds.width - 28), height: h)
            y += h
        }
    }

    // MARK: actions

    @discardableResult
    func create(_ provider: TerminalProvider, cwd: String?) throws -> TerminalRecord {
        let dims = TerminalHelpers.estimateDimensions(size: stage.bounds.size == .zero ? nil : stage.bounds.size, fontSize: Double(store.settings.fontSize))
        return try store.createSession(provider: provider, cwd: cwd, projectId: projectId, cols: dims.cols, rows: dims.rows, owner: self)
    }

    func activate(_ id: String) {
        activeId = id
        refresh()
        DispatchQueue.main.async { [weak self] in self?.store.fit(id) }
    }

    /// Brings a session of this pane forward (SHOW_TERMINAL: a Build's terminal program, a sandbox's shell).
    public func show(sessionId: String) {
        guard mySessions.contains(where: { $0.id == sessionId }) else { return }
        activate(sessionId)
    }

    @discardableResult
    func launch(_ provider: TerminalProvider, at cwd: String?) -> TerminalRecord? {
        if provider != .shell, let info = store.providers[provider.rawValue], !info.available { return nil }
        launching = .provider(provider.rawValue)
        do {
            let record = try create(provider, cwd: cwd ?? projectCwd)
            launching = nil
            activate(record.id)
            return record
        } catch {
            launching = .error("\(store.providerName(provider.rawValue)) could not be started: \(errorText(error))")
            refresh()
            return nil
        }
    }

    func toggleMenu() {
        if agentMenu.isOpen { agentMenu.close(); return }
        let items = Self.agents.map { agent -> AgentMenu.Item in
            let info = store.providers[agent.id]
            let available = agent.id == "shell" || info == nil || info!.available
            return AgentMenu.Item(id: agent.id, label: agent.label, available: available, current: now.agent == agent.id,
                                  tooltip: available ? "\(agent.label) in \(currentCwd ?? "home")" : "not found on PATH")
        }
        strip.menuOpen = true
        agentMenu.open(items: items, anchor: strip.agentButton) { [weak self] id in self?.pickAgent(id) }
    }

    /// The dropdown. An untouched idle terminal becomes the agent in place — that is how you choose its directory: pick
    /// the folder, then pick the agent. Otherwise the agent gets its own tab here.
    func pickAgent(_ agent: String) {
        agentMenu.close()
        let sessions = mySessions
        let currentId = current?.id
        if current != nil && running && now.agent == agent { if takeover { focusTranscript() } else { focusBox() }; return }
        let alive = { (record: TerminalRecord) in record.isRunning && record.id != currentId }
        if agent == "shell" {
            if let idle = sessions.reversed().first(where: { alive($0) && $0.description.agent == "shell" }) { activate(idle.id) } else { launch(.shell, at: currentCwd) }
            return
        }
        if let currentId, running, now.integrated, !now.busy, !touched.contains(currentId) { store.sendInput(currentId, "\(agent)\r"); return }
        let here = sessions.reversed().first { alive($0) && $0.description.agent == agent && cwdOf($0) == currentCwd }
        if let here { activate(here.id) } else if let provider = TerminalProvider(rawValue: agent) { launch(provider, at: currentCwd) }
    }

    /// The last terminal never goes (2026-09-25: "it should sort of always stay there and if there is only one it should
    /// just clear the terminal but not delete that tab"): an idle shell is cleared in place; a program running in it, or a
    /// terminal that has exited, gives way to a fresh shell where it was, as × would have ended it in any other tab.
    /// Closing never asks (memory note).
    func close(_ id: String) {
        let sessions = mySessions
        if sessions.count == 1, let only = sessions.first, only.id == id {
            let shell = only.description
            setDraft("")
            histIdx = nil
            if only.isRunning && shell.integrated && !shell.busy {
                store.clearSession(id)
                focusBox()
                return
            }
            if launch(.shell, at: cwdOf(only)) != nil { store.closeSession(id) { [weak self] _ in self?.refresh() } }
            return
        }
        let ids = sessions.map(\.id)
        let index = ids.firstIndex(of: id) ?? 0
        let wasCurrent = id == current?.id
        store.closeSession(id) { [weak self] closed in
            guard let self, closed else { return }
            if wasCurrent {
                let remaining = self.mySessions
                self.activeId = remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)].id
            }
            self.refresh()
        }
    }

    /// The directory chip: pick a folder. An idle shell changes into it (and reports it back through its marks);
    /// otherwise the choice is kept for the next thing started from this tab.
    func changeCwd() {
        guard let host else { return }
        host.terminalPickDirectory(current: currentCwd, window: view.window) { [weak self] chosen in
            guard let self, let chosen, let id = self.current?.id else { return }
            let n = self.now
            if self.running && n.integrated && !n.busy { self.store.sendInput(id, "cd -- \(Self.shellQuote(chosen))\r") }
            else if self.running && !n.integrated && n.agent == "shell" {
                self.store.sendInput(id, "cd -- \(Self.shellQuote(chosen))\r")
                self.cwdOverride[id] = chosen
            } else { self.cwdOverride[id] = chosen }
            self.refresh()
            self.focusBox()
        }
    }

    /// Clicking the stage: a running program gets the keyboard; under an idle shell the box keeps the caret.
    func stageClicked() {
        guard current != nil else { return }
        if !boxIsInput { focusTranscript(); return }
        focusBox()
    }

    // MARK: the box

    var draft: String { footer.field.stringValue }

    func setDraft(_ text: String) {
        footer.field.stringValue = text
        if let editor = footer.field.currentEditor() { editor.string = text; editor.selectedRange = NSRange(location: (text as NSString).length, length: 0) }
    }

    public func controlTextDidChange(_ obj: Notification) { histIdx = nil }

    public func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        // The key monitor handles these first; this only keeps the field from ending its editing on them.
        [#selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertTab(_:)), #selector(NSResponder.insertBacktab(_:)),
         #selector(NSResponder.moveUp(_:)), #selector(NSResponder.moveDown(_:))].contains(commandSelector)
    }

    var boxHasKeys: Bool {
        guard let editor = view.window?.firstResponder as? NSTextView else { return false }
        return editor.delegate === footer.field
    }

    /// The box: Enter sends the line; ↑/↓ walk the shell's history and what you typed here; ^C ^D ^L reach the shell;
    /// ⌘C with nothing selected in the box copies the transcript selection. → whether the key was taken.
    func boxKey(_ event: NSEvent) -> Bool {
        guard let id = current?.id else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        switch event.keyCode {
        case 36, 76: // Enter
            if flags.contains(.shift) { return true }
            let text = draft
            if running { store.sendInput(id, "\(text)\r") }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                history = Array((history.filter { $0 != text } + [text]).suffix(500))
                touched.insert(id)
            }
            histIdx = nil
            setDraft("")
            return true
        case 126: // ↑
            guard !history.isEmpty else { return false }
            let idx = histIdx == nil ? history.count - 1 : max(0, histIdx! - 1)
            histIdx = idx
            setDraft(history[idx])
            return true
        case 125: // ↓
            guard let current = histIdx else { return false }
            let idx = current + 1
            if idx >= history.count { histIdx = nil; setDraft("") } else { histIdx = idx; setDraft(history[idx]) }
            return true
        case 48: // Tab
            return true
        case 53: // Escape
            view.window?.makeFirstResponder(nil)
            return true
        default: break
        }
        if flags.contains(.command) && key == "c" {
            let selection = (view.window?.firstResponder as? NSTextView)?.selectedRange() ?? NSRange(location: 0, length: 0)
            let text = selection.length == 0 ? store.selectionText(id) : ""
            if !text.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                return true
            }
            return false
        }
        if flags == [.control] {
            if key == "c" { if running { store.sendInput(id, Self.ctrlC) }; setDraft(""); histIdx = nil; return true }
            if key == "d" && draft.isEmpty { if running { store.sendInput(id, Self.ctrlD) }; return true }
            if key == "l" { if running { store.sendInput(id, Self.ctrlL) }; return true }
        }
        return false
    }

    // MARK: keys, pointer, focus

    private func isInside(_ responder: NSResponder?) -> Bool {
        guard let responder else { return false }
        if let editor = responder as? NSTextView, editor.delegate === footer.field { return true }
        if let view = responder as? NSView { return view.isDescendant(of: root) || mySessions.contains { $0.view === view } }
        return false
    }

    private func installMonitors() {
        guard keyMonitor == nil, let window = view.window else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let taken = MainActor.assumeIsolated { self.handleKey(event) }
            return taken ? nil : event
        }
        // Option scrolls ten times faster (xterm's fastScrollSensitivity), as in the Electron transcript.
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            MainActor.assumeIsolated { self.scrollWillHappen(option: event.modifierFlags.contains(.option), in: event.window) }
            return event
        }
        // Over a locked transcript the pointer is the arrow, not the text beam (`.terminal-view.locked .xterm`).
        moveMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .mouseEntered]) { [weak self] event in
            guard let self else { return event }
            MainActor.assumeIsolated {
                guard let record = self.current, record.view.locked, event.window === self.view.window, record.view.superview != nil else { return }
                let point = record.view.convert(event.locationInWindow, from: nil)
                if record.view.bounds.contains(point) { DispatchQueue.main.async { NSCursor.arrow.set() } }
            }
            return event
        }
        responderObservation = window.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.firstResponderChanged() }
        }
        windowObservers = [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification].map {
            NotificationCenter.default.addObserver(forName: $0, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateTouch() }
            }
        }
    }

    /// Option held: xterm's fastScrollSensitivity (10); else its scrollSensitivity (2.5).
    func scrollWillHappen(option: Bool, in window: NSWindow?) {
        guard let record = current, window === view.window else { return }
        record.view.scrollSensitivity = option ? TerminalTheme.fastScrollSensitivity : TerminalTheme.scrollSensitivity
    }

    private func removeMonitors() {
        for monitor in [keyMonitor, scrollMonitor, moveMonitor].compactMap({ $0 }) { NSEvent.removeMonitor(monitor) }
        keyMonitor = nil; scrollMonitor = nil; moveMonitor = nil
        responderObservation?.invalidate()
        responderObservation = nil
        windowObservers.forEach { NotificationCenter.default.removeObserver($0) }
        windowObservers = []
    }

    /// While focus is in the pane: ⌘T opens a new terminal, ⌘W closes the current tab and ⌘1–9 switch tabs. ⌘T opens a
    /// terminal whenever the Terminal shows, wherever the keyboard is (2026-09-25), unless the middle canvas was clicked
    /// last (`terminalKeysToDoc`, 2026-10-16). Ctrl+digits pass through (the projects switcher's). → whether it was taken.
    func handleKey(_ event: NSEvent) -> Bool {
        guard visible, let window = view.window, event.window === window else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let inside = isInside(window.firstResponder)
        if flags == [.command] && key == "t" {
            if !inside && host?.terminalKeysToDoc() == true { return false }
            launch(.shell, at: projectCwd)
            return true
        }
        if inside, let id = current?.id, flags == [.command], key == "w" { close(id); return true }
        if inside, flags == [.command], key.count == 1, let digit = Int(key), (1...9).contains(digit) {
            let sessions = mySessions
            guard digit - 1 < sessions.count else { return false }
            activate(sessions[digit - 1].id)
            return true
        }
        if boxHasKeys { return boxKey(event) }
        if let record = current, window.firstResponder === record.view {
            if record.view.locked {
                // A key that reaches the locked transcript goes to the box.
                focusBox()
                if let chars = event.characters, chars.count == 1, !flags.contains(.control), !flags.contains(.option), !flags.contains(.command),
                   let scalar = chars.unicodeScalars.first, scalar.value >= 0x20, scalar.value != 0x7f {
                    setDraft(draft + chars)
                }
                return true
            }
            let action = TerminalHelpers.terminalKeyAction(.init(key: event.keyCode == 36 || event.keyCode == 76 ? "Enter" : key,
                                                                 shift: flags.contains(.shift), alt: flags.contains(.option),
                                                                 ctrl: flags.contains(.control), meta: flags.contains(.command),
                                                                 composing: record.view.hasMarkedText()))
            if action == .lineFeed { store.input(record.id, bytes: [0x0a]); return true }
        }
        return false
    }

    // MARK: sandbox touch

    /// A sandbox's shell in front of a focused window is in use: its sandbox stays awake (it sleeps 10 minutes after).
    private func updateTouch() {
        let libraryId: String? = {
            guard visible, view.window?.isKeyWindow == true, let record = current, record.snapshot.provider == .sandbox, record.isRunning else { return nil }
            return record.snapshot.libraryId
        }()
        guard libraryId != touching else { return }
        stopTouching()
        guard let libraryId else { return }
        touching = libraryId
        host?.terminalTouchSandbox(libraryId: libraryId)
        touchTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.host?.terminalTouchSandbox(libraryId: libraryId) }
        }
    }

    private func stopTouching() {
        touchTimer?.invalidate()
        touchTimer = nil
        touching = nil
    }
}

// MARK: - the pane's own views

final class PaneRootView: FlippedView {
    var onLayout: (() -> Void)?
    override func layout() { super.layout(); onLayout?() }
    override func draw(_ dirtyRect: NSRect) { Palette.bg.setFill(); dirtyRect.fill() }
}

/// The area the transcript sits in; a press on it (not on the transcript) is the pane's stage click.
final class StageView: FlippedView {
    var onPress: (() -> Void)?
    var cursorIsText = false { didSet { if cursorIsText != oldValue { window?.invalidateCursorRects(for: self) } } }
    override func draw(_ dirtyRect: NSRect) { Palette.bg.setFill(); dirtyRect.fill() }
    override func mouseDown(with event: NSEvent) { onPress?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: cursorIsText ? .iBeam : .arrow) }
}

/// `# message` in the stage, red for errors, with × to dismiss one of the store's.
final class MessageLine: FlippedView {
    let text: NSAttributedString
    let dismissButton: PaneButton?

    init(text: String, font: NSFont, color: NSColor, dismiss: (() -> Void)?) {
        self.text = Text.attributed(text, font: font, color: color)
        if let dismiss {
            let button = PaneButton { button, rect in
                let mark = Text.attributed("×", font: Fonts.mono(12), color: Palette.fnt)
                Text.draw(mark, x: rect.midX - Text.width(mark) / 2, top: rect.minY, lineHeight: rect.height)
            }
            button.action = dismiss
            button.setAccessibilityLabel("Dismiss")
            dismissButton = button
        } else {
            dismissButton = nil
        }
        super.init(frame: .zero)
        if let dismissButton { addSubview(dismissButton) }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        dismissButton?.frame = NSRect(x: bounds.width - 14, y: 0, width: 14, height: bounds.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        Palette.bg.setFill()
        let width = Text.width(text) + 8 + (dismissButton != nil ? 22 : 0)
        NSRect(x: 0, y: 0, width: min(bounds.width, width), height: bounds.height).fill()
        Text.draw(text, x: 0, top: 0, lineHeight: bounds.height, width: max(0, bounds.width - (dismissButton != nil ? 22 : 0)))
    }
}

import AppKit
import EngelbartCore
import SwiftTerm

// Port of src/renderer/terminal/sessions.js: the terminal session store, one for the app, so sessions and their
// transcripts survive a pane being hidden or a window closing (the shell keeps running). Each record is a session of the
// SessionManager, its SwiftTerm view, the shell state its OSC 633 marks report, and the project that owns it.
//
// Main thread only.

/// What the agent menu offers (Tools' `providers(shell)`: { id, name, available, path, authenticated }).
public struct TerminalProviderInfo: Equatable, Sendable {
    public var id: String
    public var name: String
    public var available: Bool
    public var path: String?
    public var authenticated: Bool?
    public init(id: String, name: String, available: Bool, path: String? = nil, authenticated: Bool? = nil) {
        self.id = id; self.name = name; self.available = available; self.path = path; self.authenticated = authenticated
    }
}

public struct TerminalErrorEntry: Equatable, Sendable {
    public var at: Double
    public var message: String
}

/// One session as the pane sees it (sessions.js `record`).
@MainActor
public final class TerminalRecord {
    public internal(set) var snapshot: SessionSnapshot
    public internal(set) var displayTitle: String
    public internal(set) var shell: ShellState
    public internal(set) var projectId: String?
    public let view: TranscriptView
    /// The pane showing it (several windows: a session's output goes to the window that holds it).
    weak var owner: AnyObject?
    var scanner = OscScanner()
    var lastDimensions: (cols: Int, rows: Int)
    var lastSequence = 0
    let delegateBox: ViewDelegate

    public var id: String { snapshot.id }
    public var isRunning: Bool { snapshot.status == .running }
    public var description: TabDescription { TabDescription.of(provider: snapshot.provider, shell: shell) }

    init(snapshot: SessionSnapshot, projectId: String?, fontSize: CGFloat, store: TerminalSessions) {
        self.snapshot = snapshot
        self.snapshot.history = []
        displayTitle = snapshot.title.isEmpty ? snapshot.provider.name : snapshot.title
        shell = .initial(provider: snapshot.provider, cwd: snapshot.cwd)
        self.projectId = projectId
        lastDimensions = (snapshot.cols, snapshot.rows)
        let geometry = (try? TerminalHelpers.initialTerminalGeometry(cols: snapshot.cols, rows: snapshot.rows)) ?? (cols: 80, rows: 24)
        view = TranscriptView(cols: geometry.cols, rows: geometry.rows, fontSize: fontSize)
        delegateBox = ViewDelegate()
        delegateBox.store = store
        delegateBox.id = snapshot.id
        view.terminalDelegate = delegateBox
        view.setAccessibilityLabel("\(TerminalSessions.providerName(snapshot.provider.rawValue, providers: store.providers)) terminal")
    }

    /// SwiftTerm's delegate for this record's view.
    @MainActor
    final class ViewDelegate: TerminalViewDelegate {
        weak var store: TerminalSessions?
        var id = ""

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            let id = self.id
            DispatchQueue.main.async { [weak self] in self?.store?.fit(id) }
        }
        func setTerminalTitle(source: TerminalView, title: String) {
            let id = self.id
            DispatchQueue.main.async { [weak self] in self?.store?.titleChanged(id, title) }
        }
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            store?.input(id, bytes: Array(data))
        }
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            let id = self.id
            DispatchQueue.main.async { [weak self] in self?.store?.openLink(link, from: id) }
        }
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                DispatchQueue.main.async {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
            }
        }
        func clipboardRead(source: TerminalView) -> Data? { nil }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

@MainActor
public final class TerminalSessions {
    /// App-wide wiring, given once at launch (the app adapts the Tools package and the process environment to it).
    public struct Configuration {
        /// The environment sessions start from (the app's process environment). The launcher is put in as SHELL.
        public var environment: [String: String] = ProcessInfo.processInfo.environment
        /// What the terminal adds at each start: Tools' `environment()` (ENGELBART_GIT_BIN, ENGELBART_AGENT_PATH,
        /// ENGELBART_CLAUDE_BIN, ENGELBART_CODEX_BIN).
        public var extraEnvironment: () -> [String: String] = { [:] }
        /// Tools' `providers(shell)`: what the agent menu offers. Asked at bootstrap and after every `engelbart:tools`.
        public var providers: (_ shell: String, _ done: @escaping (Result<[TerminalProviderInfo], Error>) -> Void) -> Void = { shell, done in
            done(.success([TerminalProviderInfo(id: "shell", name: "Shell", available: true, path: shell)]))
        }
        /// The app-private folder (launcher, wrappers, settings.json).
        public var userData: URL = TerminalPaths.userData
        public var home: String = TerminalPaths.home
        /// A link clicked in a transcript, when no pane owns the session (a pane's host opens it on its Stage).
        public var openLink: (String) -> Void = { _ in }
        public init() {}
    }

    private static var sharedStore: TerminalSessions?

    /// The app's store. `configure` first; until then a default one (process environment, Engelbart Swift's userData).
    public static var shared: TerminalSessions {
        if let store = sharedStore { return store }
        let store = TerminalSessions(configuration: Configuration())
        sharedStore = store
        return store
    }

    /// Makes the app's store with `configuration` (call once, at launch, before any pane).
    @discardableResult
    public static func configure(_ configuration: Configuration) -> TerminalSessions {
        let store = TerminalSessions(configuration: configuration)
        sharedStore = store
        return store
    }

    public let configuration: Configuration
    public let manager: SessionManager
    public let settingsStore: TerminalSettingsStore
    public private(set) var settings: TerminalSettings
    public let home: String
    public private(set) var ready = false
    public private(set) var bootstrapComplete = false
    public private(set) var providers: [String: TerminalProviderInfo] = ["shell": TerminalProviderInfo(id: "shell", name: "Shell", available: true)]
    public private(set) var errors: [TerminalErrorEntry] = []
    private var records: [String: TerminalRecord] = [:]
    private var order: [String] = []
    private var listeners: [UUID: () -> Void] = [:]
    private var toolsToken: EventHub.Token?
    private var lastErrorAt = 0.0

    public static let providerNames = ["shell": "Shell", "claude": "Claude Code", "codex": "Codex", "sandbox": "Sandbox"]

    static func providerName(_ id: String, providers: [String: TerminalProviderInfo]) -> String {
        providers[id]?.name ?? providerNames[id] ?? id
    }

    public func providerName(_ id: String) -> String { Self.providerName(id, providers: providers) }

    public init(configuration: Configuration, manager: SessionManager? = nil) {
        self.configuration = configuration
        home = configuration.home
        settingsStore = TerminalSettingsStore(userData: configuration.userData, home: configuration.home)
        settings = settingsStore.get()
        if let manager {
            self.manager = manager
        } else {
            var environment = configuration.environment
            if let prepared = try? ShellRC.environmentForSessions(configuration.environment, userData: configuration.userData.path) { environment = prepared }
            var options = SessionManager.Options(environment: environment)
            options.extraEnvironment = configuration.extraEnvironment
            self.manager = SessionManager(options: options)
        }
        // Flow control follows each session's consumer: on while this store shows it (has its view).
        self.manager.options.attached = { [weak self] id in MainActor.assumeIsolated { self?.records[id] != nil } }
        // The manager calls back on the main queue.
        self.manager.onData { [weak self] event in MainActor.assumeIsolated { self?.received(event) } }
        self.manager.onExit { [weak self] event in MainActor.assumeIsolated { self?.exited(event) } }
    }

    deinit { if let toolsToken { EventHub.shared.off(toolsToken) } }

    // MARK: change notification

    public struct Subscription: Hashable { let id: UUID }

    /// Called after anything a pane draws changed (sessions, marks, titles, exits, providers, errors).
    @discardableResult
    public func subscribe(_ listener: @escaping () -> Void) -> Subscription {
        let id = UUID(); listeners[id] = listener; return Subscription(id: id)
    }

    public func unsubscribe(_ subscription: Subscription) { listeners[subscription.id] = nil }

    func notify() {
        for listener in Array(listeners.values) { listener() } // a failing listener cannot break the others in Swift
    }

    func pushError(_ message: String) {
        var at = Time.ms()
        if at <= lastErrorAt { at = lastErrorAt + 1 } // `at` is an entry's identity (dismiss)
        lastErrorAt = at
        errors = Array((errors + [TerminalErrorEntry(at: at, message: message)]).suffix(10))
        notify()
    }

    public func dismissError(at: Double) {
        errors.removeAll { $0.at == at }
        notify()
    }

    // MARK: bootstrap

    /// Once: the sessions the manager already has (none the first time), the providers, and a refresh of the providers
    /// whenever the tool check reports (Claude Code or Codex installed while the app is open).
    public func bootstrap() {
        guard !bootstrapComplete else { return }
        for snapshot in manager.list() where records[snapshot.id] == nil { _ = add(snapshot, projectId: nil) }
        ready = true
        bootstrapComplete = true
        notify()
        refreshProviders()
        toolsToken = EventHub.shared.on("engelbart:tools") { [weak self] _ in MainActor.assumeIsolated { self?.refreshProviders(reportFailure: false) } }
    }

    public func refreshProviders(reportFailure: Bool = true) {
        let shell = (try? Launch.resolveShell(configuration.environment)) ?? "/bin/zsh"
        configuration.providers(shell) { [weak self] result in
            let apply = {
                guard let self else { return }
                switch result {
                case .success(let list):
                    for provider in list { self.providers[provider.id] = provider }
                    self.notify()
                case .failure(let error):
                    if reportFailure { self.pushError("CLI availability could not be checked: \(errorText(error))") }
                }
            }
            if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
        }
    }

    // MARK: records

    public var all: [TerminalRecord] { order.compactMap { records[$0] } }

    public func record(_ id: String) -> TerminalRecord? { records[id] }

    public func sessions(for projectId: String?) -> [TerminalRecord] { all.filter { $0.projectId == projectId } }

    @discardableResult
    func add(_ snapshot: SessionSnapshot, projectId: String?) -> TerminalRecord {
        if let known = records[snapshot.id] { return known }
        let record = TerminalRecord(snapshot: snapshot, projectId: projectId, fontSize: CGFloat(settings.fontSize), store: self)
        // Pastes and links go through the host of the pane that shows the session (MATH-24's pdfText; the Stage).
        record.view.pasteTransform = { [weak record] text in (record?.owner as? TerminalPaneController)?.host?.terminalPdfText(text) ?? text }
        records[snapshot.id] = record
        order.append(snapshot.id)
        // Its output so far, as it came (bootstrap history), then everything live: both on this thread, nothing between.
        for entry in manager.historyBytes(snapshot.id) { consume(record, sequence: entry.sequence, bytes: entry.bytes, acknowledge: false) }
        if let current = manager.get(snapshot.id), current.status == .exited {
            record.snapshot.status = .exited
            record.snapshot.exitCode = current.exitCode
            record.snapshot.signal = current.signal
        } else if snapshot.status == .exited {
            record.snapshot.status = .exited
            record.snapshot.exitCode = snapshot.exitCode
            record.snapshot.signal = snapshot.signal
        }
        notify()
        return record
    }

    func remove(_ id: String) {
        guard let record = records[id] else { return }
        record.view.removeFromSuperview()
        record.view.terminalDelegate = nil
        records[id] = nil
        order.removeAll { $0 == id }
        notify()
    }

    private func received(_ event: SessionData) {
        guard let record = records[event.id] else { return }
        consume(record, sequence: event.sequence, bytes: event.bytes, acknowledge: true)
    }

    private func consume(_ record: TerminalRecord, sequence: Int, bytes: [UInt8], acknowledge: Bool) {
        guard sequence > record.lastSequence else { return }
        record.lastSequence = sequence
        let marks = record.scanner.scan(bytes)
        record.view.feed(byteArray: bytes[...])
        if acknowledge { manager.acknowledge(record.id, sequence) }
        var changed = false
        for mark in marks where record.shell.apply(mark) { changed = true }
        if changed { notify() }
    }

    private func exited(_ event: SessionExit) {
        guard let record = records[event.id], record.snapshot.status != .exited else { return }
        record.snapshot.status = .exited
        record.snapshot.exitCode = event.exitCode
        record.snapshot.signal = event.signal
        notify()
    }

    func titleChanged(_ id: String, _ title: String) {
        guard let record = records[id] else { return }
        let fallback = record.snapshot.title.isEmpty ? providerName(record.snapshot.provider.rawValue) : record.snapshot.title
        let normalized = SessionManager.replaceControls(title, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        record.displayTitle = normalized.isEmpty ? fallback : String(normalized.prefix(160))
        notify()
    }

    func openLink(_ uri: String, from id: String) {
        do {
            let url = try TerminalHelpers.browserLink(uri)
            if let host = (records[id]?.owner as? TerminalPaneController)?.host { host.terminalOpenLink(url) } else { configuration.openLink(url) }
        } catch {
            pushError("Link could not be opened: \(errorText(error))")
        }
    }

    // MARK: input

    /// Typing in a transcript (or a key the pane sends for it): to the PTY in ≤ 48 KiB pieces, in order.
    func input(_ id: String, bytes: [UInt8]) {
        guard let record = records[id], record.isRunning, !bytes.isEmpty else { return }
        var start = 0
        while start < bytes.count {
            var end = min(start + TerminalHelpers.defaultChunkBytes, bytes.count)
            while end < bytes.count && end > start && (bytes[end] & 0xC0) == 0x80 { end -= 1 }
            do { try manager.write(id, bytes: Array(bytes[start..<end])) } catch {
                pushError("Input could not be sent: \(errorText(error))")
                return
            }
            start = end
        }
    }

    /// Raw input to a running session: a command line typed in the pane's own box, or a control character.
    public func sendInput(_ id: String, _ text: String) {
        guard let record = records[id], record.isRunning, !text.isEmpty else { return }
        let chunks: [String]
        do { chunks = try TerminalHelpers.splitUtf8Chunks(text) } catch {
            pushError("Input could not be sent: \(errorText(error))")
            return
        }
        for chunk in chunks {
            do { try manager.write(id, chunk) } catch {
                pushError("Input could not be sent: \(errorText(error))")
                return
            }
        }
    }

    // MARK: sessions

    /// A new session for `projectId`. `cwd`: else the last directory used, else home. No dimensions: an 800 × 300
    /// estimate. The directory is remembered as the last one used.
    @discardableResult
    public func createSession(provider: TerminalProvider = .shell, cwd: String? = nil, projectId: String?, cols: Int? = nil, rows: Int? = nil,
                              owner: AnyObject? = nil) throws -> TerminalRecord {
        bootstrap()
        let dims = cols != nil && rows != nil ? (cols!, rows!) : TerminalHelpers.estimateDimensions(size: nil, fontSize: Double(settings.fontSize))
        let workingDirectory = cwd ?? (settings.lastCwd.isEmpty ? home : settings.lastCwd)
        let snapshot = try manager.create(.init(provider: provider, cwd: workingDirectory, cols: dims.0, rows: dims.1))
        let record = add(snapshot, projectId: projectId)
        record.owner = owner
        settings.lastCwd = workingDirectory
        _ = try? settingsStore.save(["lastCwd": .string(workingDirectory)])
        return record
    }

    /// A session the app opened itself (a Build's run step, a sandbox's shell): the project's from now on, even one this
    /// store already had under another project. Show it with `TerminalPaneController.show(sessionId:)` or by posting
    /// `engelbart:show-terminal` {id}.
    @discardableResult
    public func adopt(_ snapshot: SessionSnapshot, projectId: String?) -> TerminalRecord {
        bootstrap()
        if let known = records[snapshot.id] {
            if let projectId, known.projectId != projectId {
                known.projectId = projectId
                known.owner = nil
                notify()
            }
            return known
        }
        return add(snapshot, projectId: projectId)
    }

    /// A session the app closed itself (the Build was accepted or discarded): its tab goes.
    public func drop(_ id: String) { remove(id) }

    /// Ends the PTY (a running process is ended without asking) and removes the tab. → whether it closed.
    public func closeSession(_ id: String, completion: @escaping (Bool) -> Void = { _ in }) {
        manager.close(id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let closed):
                if closed { self.remove(id) }
                completion(closed)
            case .failure(let error):
                self.pushError("Session could not be closed: \(errorText(error))")
                completion(false)
            }
        }
    }

    /// Wipes a session's transcript, scrollback and all; whatever runs in it is left alone (the last tab's ×, 2026-09-25).
    @discardableResult
    public func clearSession(_ id: String) -> Bool {
        guard let record = records[id] else { return false }
        // xterm's clear(): the scrollback goes and the cursor's line becomes the top line.
        record.view.feed(text: "\u{1b}[H\u{1b}[2J")
        record.view.clearScrollback()
        record.view.selectNone()
        return true
    }

    /// The grid the view now has reaches the PTY (only when it changed and the session runs).
    func fit(_ id: String) {
        guard let record = records[id], record.view.superview != nil else { return }
        let dims = record.view.terminalDimensions
        guard dims.cols >= 2, dims.rows >= 1 else { return }
        guard record.isRunning, dims.cols != record.lastDimensions.cols || dims.rows != record.lastDimensions.rows else { return }
        record.lastDimensions = (dims.cols, dims.rows)
        do { try manager.resize(id, cols: min(500, dims.cols), rows: min(500, dims.rows)) } catch {
            pushError("Terminal could not be resized: \(errorText(error))")
        }
    }

    public func setFontSize(_ next: Int) {
        let size = max(TerminalSettings.minFontSize, min(TerminalSettings.maxFontSize, next))
        guard size != settings.fontSize else { return }
        settings.fontSize = size
        for record in all { record.view.applyFontSize(CGFloat(size)) }
        _ = try? settingsStore.save(["fontSize": .number(Double(size))])
        notify()
    }

    /// The text selected in a session's transcript ("" when none).
    public func selectionText(_ id: String) -> String { records[id]?.view.getSelection() ?? "" }

    /// Sessions still running (the quit question).
    public var runningCount: Int { manager.runningCount }
}

extension SessionManager {
    /// Raw input bytes (a key the terminal view encoded), with `write`'s checks.
    public func write(_ id: String, bytes: [UInt8]) throws {
        if bytes.count > Self.maxInputBytes { throw TerminalError("Terminal input must be a string of at most \(Self.maxInputBytes) bytes") }
        try writeRaw(id, bytes)
    }
}

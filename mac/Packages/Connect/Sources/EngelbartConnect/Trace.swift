import Foundation
import AppKit
import WebKit
import UniformTypeIdentifiers
import EngelbartCore

// Port of src/main/onboarding/trace.cjs (2026-10-13, "create a plain UI like https://mathetic.com/bart that shows the
// prompts, input, output, and context for all the agents and dispatching involved"): every turn of onboarding's agents
// and the dispatching around them, written down as it happens, in <dataRoot>/.connect/trace/<YYYY-MM-DD>.jsonl (one
// entry a line, 14 days kept), a field cut at 400,000 characters (the middle goes, with a note saying how much).
public final class Trace: @unchecked Sendable {
    public static let maxField = 400_000
    static let maxMemory = 400, maxDays = 14, maxActivity = 300, maxPictures = 80, maxTranscript = 200_000

    public static func cut(_ value: JSONValue?, _ max: Int = maxField) -> String {
        let text = value.map { $0.string ?? $0.text(pretty: true) } ?? ""
        return cut(text, max)
    }
    public static func cut(_ text: String, _ max: Int = maxField) -> String {
        let chars = Array(text)
        if chars.count <= max { return text }
        let half = (max - 80) / 2
        return String(chars.prefix(half)) + "\n\n[… \(chars.count - 2 * half) characters left out of the trace …]\n\n" + String(chars.suffix(half))
    }

    let dataRoot: () -> String
    public var notify: (JSONValue) -> Void
    let now: () -> String
    let lock = NSLock()
    var recent: [JSONValue] = []

    public init(dataRoot: @escaping () -> String, notify: @escaping (JSONValue) -> Void = { _ in }, now: @escaping () -> String = { Time.iso() }) {
        self.dataRoot = dataRoot; self.notify = notify; self.now = now
    }

    var dir: URL { URL(fileURLWithPath: dataRoot()).appendingPathComponent(".connect/trace") }

    func write(_ entry: JSONValue) {
        let day = String(JS.string(entry["at"]).prefix(10))
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appendingPathComponent("\(day).jsonl")
        let line = Data((entry.text() + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: file) { h.seekToEndOfFile(); h.write(line); try? h.close() }
        else { FileManager.default.createFile(atPath: file.path, contents: line, attributes: [.posixPermissions: 0o600]) }
    }

    @discardableResult
    func keep(_ entry: JSONValue) -> JSONValue {
        lock.lock()
        if let at = recent.firstIndex(where: { $0["id"] == entry["id"] }) { recent[at] = entry } else { recent.append(entry) }
        if recent.count > Self.maxMemory { recent.removeFirst(recent.count - Self.maxMemory) }
        lock.unlock()
        write(entry)
        notify(entry)
        return entry
    }

    /// A turn's entry while it runs (mutable; kept again as it changes).
    public final class Turn: @unchecked Sendable { var value: [String: JSONValue]; init(_ v: [String: JSONValue]) { value = v } }

    public func turnStarted(_ input: AgentTurnInput) -> Turn {
        var v: [String: JSONValue] = [
            "id": .string(IDs.new()), "type": "turn", "at": .string(now()), "ended": .null, "status": "running", "kind": .string(input.kind),
            "provider": .string(input.choice.provider), "model": .string(input.choice.modelName.isEmpty ? input.choice.model : input.choice.modelName), "modelId": .string(input.choice.modelId),
            "effort": .string(input.choice.effort), "label": .string(input.meta.jobLabel ?? input.meta.label ?? input.kind), "sessionId": input.meta.sessionId.map { .string($0) } ?? .null,
            "jobId": input.meta.jobId.map { .string($0) } ?? .null, "resumed": .bool(input.session != nil), "agentSession": input.session.map { .string($0) } ?? .null,
            "dirs": .array(input.dirs.prefix(40).map { .string($0) }), "system": .string(Self.cut(input.system)), "message": .string(Self.cut(input.message)),
            "output": "", "error": "", "activity": [],
        ]
        if input.kind == "browse" { v["command"] = ""; v["pictures"] = []; v["transcript"] = "" }
        let t = Turn(v)
        keep(.object(t.value))
        return t
    }

    func activity(_ t: Turn, _ text: String) {
        var list = t.value["activity"]?.array ?? []
        if list.last?["text"]?.string == text { return }
        list.append(["at": .string(now()), "text": .string(String(text.prefix(300)))])
        if list.count > Self.maxActivity { list.removeFirst(list.count - Self.maxActivity) }
        t.value["activity"] = .array(list)
    }

    func browse(_ t: Turn, _ u: AgentUpdate) {
        if let command = u.command { t.value["command"] = .string(String(command.prefix(4000))) }
        if let picture = u.picture, var pics = t.value["pictures"]?.array, pics.count < Self.maxPictures {
            pics.append(["at": .string(now()), "file": .string(picture)]); t.value["pictures"] = .array(pics); keep(.object(t.value))
        }
        if let transcript = u.transcript { t.value["transcript"] = .string(Self.cut(transcript, Self.maxTranscript)) }
    }

    func ended(_ t: Turn, output: String = "", error: String = "", session: String? = nil) {
        t.value["ended"] = .string(now())
        t.value["status"] = .string(error.isEmpty ? "done" : "failed")
        t.value["output"] = .string(Self.cut(output))
        t.value["error"] = .string(Self.cut(error, 4000))
        if let session { t.value["agentSession"] = .string(session) }
        keep(.object(t.value))
    }

    /// Dispatching: { kind: 'dispatch' | 'need' | 'log' | 'start' | …, sessionId, jobId, text, detail }.
    @discardableResult
    public func event(kind: String = "log", sessionId: String? = nil, jobId: String? = nil, text: String = "", detail: JSONValue? = nil) -> JSONValue {
        keep(["id": .string(IDs.new()), "type": "event", "at": .string(now()), "kind": .string(kind), "sessionId": sessionId.map { .string($0) } ?? .null,
              "jobId": jobId.map { .string($0) } ?? .null, "text": .string(String(text.prefix(2000))), "detail": detail.map { .string(Self.cut($0, 60_000)) } ?? .null])
    }

    /// The last entries kept, oldest first; with none in memory yet, the last two days' files (old days removed).
    public func list() -> [JSONValue] {
        lock.lock(); let held = recent; lock.unlock()
        if !held.isEmpty { return held }
        var out: [JSONValue] = []
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { JS.test($0, #"^\d{4}-\d{2}-\d{2}\.jsonl$"#) }.sorted()
        for name in files.suffix(2) {
            for line in ((try? String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)) ?? "").components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
                guard let entry = try? JSONValue.parse(line) else { continue }
                if let at = out.firstIndex(where: { $0["id"] == entry["id"] }) { out[at] = entry } else { out.append(entry) }
            }
        }
        for name in files.prefix(max(0, files.count - Self.maxDays)) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(name)) }
        return Array(out.suffix(Self.maxMemory))
    }

    /// `agents` with every turn traced.
    public func wrap(_ agents: ConnectAgents) -> ConnectAgents { TracedAgents(agents, self) }
}

final class TracedAgents: ConnectAgents, @unchecked Sendable {
    let agents: ConnectAgents
    let trace: Trace
    init(_ a: ConnectAgents, _ t: Trace) { agents = a; trace = t }
    func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput {
        let entry = trace.turnStarted(input)
        var wrapped = input
        let trace = self.trace
        wrapped.onUpdate = { u in
            if let a = u.activity { trace.activity(entry, a) }
            if u.command != nil || u.picture != nil || u.transcript != nil { trace.browse(entry, u) }
            input.onUpdate(u)
        }
        do {
            let out = try await agents.turn(wrapped)
            trace.ended(entry, output: out.text, session: out.session)
            return out
        } catch {
            trace.ended(entry, error: (error as? ConnectError)?.message ?? error.localizedDescription)
            throw error
        }
    }
}

/// Port of onboarding/trace-window.cjs + trace.html + trace-preload.cjs: View ▸ Agent Trace, the same page in a WKWebView
/// with `window.traceApi` (list, save, reveal, onEntry) answered over a script message handler.
@MainActor
public final class TraceWindow: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    let trace: Trace
    let traceDir: () -> URL
    var window: NSWindow?
    var web: WKWebView?

    public init(trace: Trace, traceDir: @escaping () -> URL) { self.trace = trace; self.traceDir = traceDir }

    static let shim = """
    (function () {
      var seq = 0, pending = {}, listeners = [];
      function call(name, arg) { return new Promise(function (resolve, reject) { var id = ++seq; pending[id] = { resolve: resolve, reject: reject }; window.webkit.messageHandlers.trace.postMessage({ id: id, name: name, arg: arg === undefined ? null : arg }); }); }
      window.__traceAnswer = function (id, ok, value) { var p = pending[id]; if (!p) return; delete pending[id]; if (ok) p.resolve(value); else p.reject(new Error(String(value))); };
      window.__traceEntry = function (entry) { listeners.forEach(function (l) { try { l(entry); } catch (e) {} }); };
      window.traceApi = { list: function () { return call('list'); }, save: function (html) { return call('save', html); }, reveal: function () { return call('reveal'); },
        onEntry: function (l) { listeners.push(l); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; } };
    })();
    """

    @discardableResult
    public func open() -> Bool {
        if let window { window.makeKeyAndOrderFront(nil); return true }
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(source: Self.shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "trace")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 980, height: 820), configuration: config)
        let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        win.title = "Agent trace"
        win.backgroundColor = .white
        win.contentMinSize = CGSize(width: 560, height: 400)
        win.contentView = web
        win.isReleasedWhenClosed = false
        win.delegate = self
        if let page = ResourceBundle.named("Connect_EngelbartConnect", fallback: Bundle.module).url(forResource: "trace", withExtension: "html") { web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent()) }
        win.center()
        win.makeKeyAndOrderFront(nil)
        window = win
        self.web = web
        return true
    }

    public func isOpen() -> Bool { window != nil }

    public func windowWillClose(_ notification: Notification) { window = nil; web = nil }

    /// A new or changed entry, to the window when it is open.
    public func send(_ entry: JSONValue) {
        web?.evaluateJavaScript("window.__traceEntry && window.__traceEntry(\(entry.text()))")
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let name = body["name"] as? String else { return }
        let answer = { (ok: Bool, value: JSONValue) in self.web?.evaluateJavaScript("window.__traceAnswer(\(id), \(ok), \(value.text()))") }
        switch name {
        case "list": answer(true, .array(trace.list()))
        case "reveal":
            let dir = traceDir()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            NSWorkspace.shared.open(dir)
            answer(true, true)
        case "save":
            guard let html = body["arg"] as? String, html.hasPrefix("<!doctype html>"), html.utf16.count <= 60_000_000 else { answer(false, "html is invalid"); return }
            let panel = NSSavePanel()
            panel.title = "Save agent trace"
            let stamp = JS.replace(String(Time.iso().prefix(16)), "[:T]", "-")
            panel.nameFieldStringValue = "Engelbart agent trace \(stamp).html"
            panel.allowedContentTypes = [.html]
            let finish = { (r: NSApplication.ModalResponse) in
                guard r == .OK, let url = panel.url else { answer(true, ""); return }
                FileManager.default.createFile(atPath: url.path, contents: Data(html.utf8), attributes: [.posixPermissions: 0o600])
                answer(true, .string(url.path))
            }
            if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
        default: answer(false, "unknown")
        }
    }
}

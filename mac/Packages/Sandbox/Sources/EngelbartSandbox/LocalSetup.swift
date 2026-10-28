import Foundation
import EngelbartCore

// src/main/sandbox/local-setup.cjs: Claude first says how a person uses the repository (declare_kind): through a web
// interface, from a terminal, or both. It is ready once that kind has what it needs: a verified preview (start_app), a
// terminal (terminal_ready), or both.

public enum LocalSetup {
    static let state = "/home/user/.engelbart-canvas"
    static let adapter = "\(state)/launch.py"
    /// The app and its proxy have no time limit: they live as long as the sandbox, which sleeps and wakes with them running.
    static let forever = 0

    /// A desktop app (discovery's `desktop` hint) has no web page of its own to preview: its window's page needs the app
    /// around it, and showed blank in the Stage (2026-10-04). Until a sandbox can show a desktop, setup stops before Claude.
    public static let desktopUnsupported = "Desktop apps are not supported yet"
    static let desktopNames = ["electron": "Electron", "@tauri-apps/cli": "Tauri", "@tauri-apps/api": "Tauri", "tauri": "Tauri", "nw": "NW.js", "@neutralinojs/lib": "Neutralino"]

    static func desktopApp(_ discovery: JSONValue) -> String? {
        for component in discovery["components"]?.array ?? [] {
            if let hint = component["hints"]?["desktop"]?.array, let first = hint.first {
                return first.string.flatMap { desktopNames[$0] } ?? "desktop"
            }
        }
        return nil
    }

    /// What is ready: `{ kind, reason, preview_url?, port?, terminal? }` and the app's command (`done`) when there is an app.
    public struct Ready: @unchecked Sendable {
        public var kind: String
        public var reason: String
        public var previewURL: String?
        public var port: Int?
        public var terminal: JSONValue?
        public var done: E2BCommandHandle?
    }

    /// The agent runner (`runLocalClaude` by default; tests pass a fake).
    public typealias RunAgent = (_ auth: LocalClaudeAuth?, _ bridge: ToolBridge.Connection, _ prompt: String, _ model: String,
                                 _ signal: AbortSignal, _ onMessage: @escaping (String) -> Void) async throws -> String

    public static let defaultRunAgent: RunAgent = { auth, bridge, prompt, model, signal, onMessage in
        guard let auth else { throw SandboxError(LocalClaude.notInstalled) }
        return try await LocalClaude.run(auth: auth, bridge: bridge, prompt: prompt, model: model, signal: signal, onMessage: onMessage)
    }

    public typealias Discover = (_ sandbox: E2BSandbox, _ signal: AbortSignal, _ secrets: [String], _ onEvent: @escaping (JSONValue) -> Void) async throws -> JSONValue

    public static let defaultDiscover: Discover = { sandbox, signal, secrets, onEvent in
        try await LaunchDiscovery.discover(sandbox: sandbox, signal: signal, secrets: secrets, onEvent: onEvent)
    }

    /// `runLocalSetup`. `checkPreview(url)`: whether the public preview answers like a page.
    public static func run(sandbox: E2BSandbox, auth: LocalClaudeAuth?, environment: SavedEnvironment, model: String, signal parentSignal: AbortSignal?,
                           onEvent: @escaping (JSONValue) -> Void, checkPreview: @escaping (String) async -> Bool,
                           onReady: @escaping (Ready) -> Void = { _ in }, runAgent: RunAgent = defaultRunAgent, discover: Discover = defaultDiscover,
                           bridgeOpener: ((@escaping (String, JSONValue?) async throws -> JSONValue, [String], AbortSignal) async throws -> (ToolBridge.Connection, () -> Void))? = nil) async throws -> Ready {
        let controller = AbortSignal()
        let signal = parentSignal.map { AbortSignal.any([$0, controller]) } ?? controller
        let secrets = Array(environment.values.values)
        let s = SetupState()

        func appStatus(_ port: Int? = nil) async throws -> JSONValue {
            let result = try await sandbox.run("python3 \(adapter) --app-status\(port.map { " --port \($0)" } ?? "")", timeoutMs: 15_000)
            guard let app = try? JSONValue.parse(result.stdout), app["running"]?.bool != nil, app["processes"]?.array != nil, app["listeners"]?.array != nil else {
                throw SandboxError("Application status is unavailable; do not assume the app stopped")
            }
            s.with { $0.currentApp = app }
            onEvent(["phase": "app_status", "status": app["status"] ?? .null, "message": "Application processes and listeners checked", "app": app])
            return app
        }
        func stopApp(_ attempt: String? = nil) async throws -> JSONValue {
            let id = try await { () async throws -> String? in if let attempt { return attempt }; return try await appStatus()["attempt_id"]?.string }()
            if let id {
                if !id.matches("^[a-f0-9-]{36}$") { throw SandboxError("Invalid application attempt") }
                let result = try await sandbox.run("python3 \(adapter) --stop-app \(id)", timeoutMs: 20_000)
                if result.exitCode != 0 { throw SandboxError("Could not confirm application cleanup; no replacement can start") }
            }
            s.with { $0.launched = nil }
            let app = try await appStatus()
            if app["running"]?.bool == true { throw SandboxError("Owned application processes are still running; no replacement can start") }
            s.remember(app)
            onEvent(["phase": "app_status", "status": "stopped", "message": "Owned application processes stopped", "app": app])
            return app
        }
        let tools = Locked<SandboxTools?>(nil)

        /// Published once, when the declared kind has everything it needs. No final model response is on the critical path.
        func readiness() -> Ready? {
            let ready: Ready? = s.with { st in
                guard st.published == nil, let kind = st.kind, kind == "terminal" || st.launched != nil, kind == "interface" || st.terminal != nil else { return nil }
                let launched = kind != "terminal" ? st.launched : nil
                let value = Ready(kind: kind, reason: st.reason, previewURL: launched?.previewURL, port: launched?.port,
                                  terminal: kind != "interface" ? st.terminal : nil, done: launched?.done)
                st.published = value
                return value
            }
            guard let ready else { return nil }
            tools.value?.freeze()
            onReady(ready)
            s.summaryTimer = DispatchWorkItem { controller.abort(SandboxError("Ready; final summary time limit reached")) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: s.summaryTimer!)
            return ready
        }

        func startApp(_ args: [String: JSONValue]) async throws -> JSONValue {
            try signal.throwIfAborted()
            let stopped = try await sandbox.run("python3 \(adapter) --stop", timeoutMs: 20_000)
            if stopped.exitCode != 0 { throw SandboxError("Could not confirm the previous launch stopped; no replacement was started") }
            if try await appStatus()["running"]?.bool == true { throw SandboxError("The previous application is still running; no replacement was started") }
            s.with { $0.launched = nil }
            let attempt = IDs.new()
            let port = args["port"]!.int!
            let path = args["path"]?.string ?? "/"
            let recipe: JSONValue = ["kind": "claude-local", "command": args["command"]!, "cwd": .string(try SandboxToolsSpec.repoPath(args["cwd"])),
                                     "port": .number(Double(port)), "path": .string(path)]
            try await sandbox.writeFile("\(state)/recipe.json", recipe.text())
            try await sandbox.writeFile("\(state)/environment.json", environment.json.text())
            _ = try await sandbox.run("chmod 600 \(state)/recipe.json \(state)/environment.json", timeoutMs: 10_000)
            let ready = Deferred<JSONValue>()
            let timeout = DispatchWorkItem { ready.reject(SandboxError("Application did not become healthy within 90 seconds")) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: timeout)
            let abortId = signal.onAbort { ready.reject(SandboxError("Setup stopped")) }
            defer { timeout.cancel(); signal.removeListener(abortId) }
            let buffer = Locked("")
            let onStdout: (String) -> Void = { chunk in
                var lines: [String] = []
                let over = buffer.with { b -> Bool in
                    b += chunk
                    if b.utf16.count > 256_000 { b = ""; return true }
                    while let nl = b.firstIndex(of: "\n") { lines.append(String(b[..<nl])); b = String(b[b.index(after: nl)...]) }
                    return false
                }
                if over { ready.reject(SandboxError("App log line is too large")); return }
                for line in lines {
                    guard let event = try? JSONValue.parse(line), event.object != nil else { continue }
                    switch event["phase"]?.string {
                    case "ready": ready.resolve(event)
                    case "error":
                        onEvent(event)
                        ready.reject(SandboxError(event["message"]?.string ?? "Application could not start"))
                    case "app_status": s.remember(event["app"] ?? .null); onEvent(event)
                    default: onEvent(event)
                    }
                }
            }
            do {
                try signal.throwIfAborted()
                onEvent(["phase": "stage", "stage": "start", "status": "running", "command": args["command"]!])
                let handle = try await sandbox.start("python3 -u \(adapter) --local --attempt \(attempt)",
                                                     CommandOptions(timeoutMs: forever, onStdout: onStdout,
                                                                    onStderr: { text in onEvent(["phase": "log", "stream": "stderr", "text": .string(text)]) }))
                Task {
                    do { _ = try await handle.wait(); ready.reject(SandboxError("Application exited before becoming ready")) }
                    catch { ready.reject(error) }
                }
                try signal.throwIfAborted()
                let healthy = try await ready.wait()
                try signal.throwIfAborted()
                let host = healthy["host"]?.string ?? "127.0.0.1"
                if !["127.0.0.1", "::1"].contains(host) { throw SandboxError("Invalid application listening address") }
                var proxyEnv: [String: String] = [:]
                proxyEnv["ENGELBART_CANVAS_APP_ATTEMPT"] = attempt
                _ = try await sandbox.start("node /opt/engelbart/proxy.mjs \(Shell.quote("43110:\(port):\(host)"))", CommandOptions(timeoutMs: forever, envs: proxyEnv))
                let previewHost = sandbox.getHost(43110)
                guard let preview = URL(string: path, relativeTo: URL(string: "https://\(previewHost)"))?.absoluteURL, preview.host == previewHost.split(separator: ":").first.map(String.init) else {
                    throw SandboxError("Invalid preview host")
                }
                onEvent(["phase": "check", "status": "checking", "message": "Verifying live preview"])
                var reachable = false
                for _ in 0..<10 {
                    try signal.throwIfAborted()
                    if await checkPreview(preview.absoluteString) { reachable = true; break }
                    try await Task.sleep(nanoseconds: 500_000_000)
                }
                if !reachable { throw SandboxError("App started, but the public preview is not reachable. Inspect logs and retry start_app.") }
                var app = try await appStatus().object ?? [:]
                app["preview"] = ["ok": true, "url": .string(preview.absoluteString)]
                s.with { $0.currentApp = .object(app) }
                try signal.throwIfAborted()
                if app["running"]?.bool != true || app["health"]?["ok"]?.bool == false { throw SandboxError("Application stopped responding during preview verification") }
                s.with { $0.launched = Launched(port: port, previewURL: preview.absoluteString, done: handle) }
                let complete = readiness()
                var reply: [String: JSONValue] = ["ready": .bool(complete != nil), "preview_url": .string(preview.absoluteString), "port": .number(Double(port)), "app": .object(app)]
                if complete == nil { reply["next"] = "Preview verified. Now call terminal_ready." }
                return .object(reply)
            } catch {
                var before: JSONValue
                do { before = try await appStatus(port) } catch {
                    var o = s.value.currentApp.object ?? [:]; o["status_unknown"] = true; before = .object(o)
                }
                var cleanupError: String?
                do { _ = try await stopApp(attempt) } catch { cleanupError = message(of: error) }
                let text = "\(message(of: error))\(cleanupError.map { " Cleanup could not be confirmed: \($0)" } ?? " Owned app processes were stopped before returning.")"
                let current = s.value.currentApp
                onEvent(["phase": "setup", "status": "working", "message": .string(text), "app": current, "failed_check": before])
                throw SandboxError(text, details: ["app": current, "failed_check": before])
            }
        }

        let kinds = SandboxKindsControl(
            declared: { s.value.kind },
            declare: { kind, reason in
                if kind == "terminal" && s.value.launched != nil { throw SandboxError("A web app is already running: declare both, or stop_app first.") }
                s.with { $0.kind = kind; $0.reason = reason.head(500) }
                let used = kind == "interface" ? "through a web interface" : kind == "terminal" ? "from a terminal" : "through a web interface and from a terminal"
                onEvent(["phase": "kind", "kind": .string(kind), "reason": .string(s.value.reason), "message": .string("Used \(used): \(s.value.reason)")])
                if readiness() != nil { return ["kind": .string(kind), "ready": true] }
                let next = kind == "interface" ? "Install dependencies, then start_app." : kind == "terminal" ? "Install dependencies, then terminal_ready." : "Install dependencies, then start_app and terminal_ready."
                return ["kind": .string(kind), "next": .string(next)]
            },
            terminal: { cwd, hint in
                let terminal: JSONValue = ["cwd": .string(cwd), "hint": .string(hint)]
                s.with { $0.terminal = terminal }
                onEvent(["phase": "terminal", "status": "ready", "cwd": .string(cwd), "hint": .string(hint), "message": .string("Terminal ready in \(cwd)")])
                let ready = readiness()
                var reply: [String: JSONValue] = ["ready": .bool(ready != nil), "terminal": terminal]
                if ready == nil { reply["next"] = "Terminal ready. Now start the web app with start_app." }
                return .object(reply)
            })
        let install = DependencyInstall(sandbox: sandbox, environment: environment.values, secrets: secrets, signal: signal, onEvent: onEvent)
        let toolSet = SandboxTools(sandbox: sandbox, startApp: startApp, appStatus: { args in try await appStatus(args["port"]?.int) },
                                   stopApp: { try await stopApp() }, appState: { s.appState() }, install: install, onEvent: onEvent,
                                   signal: signal, secrets: secrets, environment: environment.values, kinds: kinds)
        tools.with { $0 = toolSet }
        let call: (String, JSONValue?) async throws -> JSONValue = { name, args in try await toolSet.call(name, args) }
        let (connection, closeBridge): (ToolBridge.Connection, () -> Void)
        if let bridgeOpener { (connection, closeBridge) = try await bridgeOpener(call, secrets, signal) }
        else {
            let bridge = try await ToolBridge.open(call, secrets: secrets, signal: signal)
            (connection, closeBridge) = (bridge.connection, { bridge.close() })
        }
        func cleanup() async {
            s.summaryTimer?.cancel()
            controller.abort()
            // Reject queued calls and wait for any in-flight operation before the worker either keeps the ready sandbox or
            // stops it.
            closeBridge()
            await toolSet.close()
            try? await install.close()
        }
        do {
            async let preflightTask = install.prepare()
            async let discoveryTask = discover(sandbox, signal, secrets, onEvent)
            var preflight = try await preflightTask
            let discovery = try await discoveryTask
            if let desktop = desktopApp(discovery) {
                let text = "\(desktopUnsupported): this repository is \(desktop == "Electron" ? "an" : "a") \(desktop) app, and a sandbox can show only web previews and terminals."
                onEvent(["phase": "kind", "status": "unsupported", "message": .string(text)])
                throw SandboxError(text)
            }
            if var o = preflight.object { o["install"] = install.status(); preflight = .object(o) }
            let agentStarted = Date()
            let agentEvent: (String, String) -> Void = { status, text in
                var event: [String: JSONValue] = ["phase": "agent", "provider": "claude-local", "status": .string(status), "message": .string(text)]
                if !["starting", "working"].contains(status) { event["elapsed_ms"] = .number((Date().timeIntervalSince(agentStarted) * 1000).rounded()) }
                onEvent(.object(event))
            }
            agentEvent("starting", "Starting setup agent · local Claude Code subscription (no Anthropic API key)")
            var summaryUnavailable = false
            do {
                _ = try await runAgent(auth, connection, LocalSetupPrompt.text(preflight: preflight, discovery: discovery), model, signal) { text in agentEvent("working", text) }
            } catch {
                if s.value.published == nil || (parentSignal?.aborted ?? false) {
                    agentEvent((parentSignal?.aborted ?? false) ? "stopped" : "failed", message(of: error).isEmpty ? "Setup agent failed" : message(of: error))
                    throw error
                }
                summaryUnavailable = true
                agentEvent("summary_unavailable", "Ready; Claude final summary unavailable. Application supervision continues.")
            }
            let st = s.value
            guard let published = st.published else {
                let text = st.kind == nil ? "Claude finished without saying how the repository is used."
                    : st.kind != "terminal" && st.launched == nil ? "Claude finished without a verified web preview."
                    : "Claude finished without making the terminal ready."
                agentEvent("failed", text)
                throw SandboxError(text)
            }
            if !summaryUnavailable {
                agentEvent("done", "Setup agent finished · \(published.kind == "terminal" ? "terminal ready" : published.kind == "both" ? "preview verified, terminal ready" : "preview verified")")
            }
            await cleanup()
            return published
        } catch {
            await cleanup()
            throw error
        }
    }

    struct Launched: @unchecked Sendable { var port: Int; var previewURL: String; var done: E2BCommandHandle }

    final class SetupState: @unchecked Sendable {
        struct Values {
            var launched: Launched?
            var kind: String?
            var reason = ""
            var terminal: JSONValue?
            var published: Ready?
            var currentApp: JSONValue = ["status": "idle", "running": false, "processes": [], "listeners": [], "health": nil]
            var changes: [JSONValue] = []
        }
        private let lock = NSRecursiveLock()
        private var values = Values()
        var summaryTimer: DispatchWorkItem?
        var value: Values { lock.withLock { values } }
        @discardableResult func with<T>(_ body: (inout Values) -> T) -> T { lock.withLock { body(&values) } }
        func remember(_ app: JSONValue) {
            with { v in
                v.currentApp = app
                let listeners: JSONValue = app["listeners"]?.array.map { .array(Array($0.prefix(8))) } ?? .null
                v.changes = Array((v.changes + [["attempt_id": app["attempt_id"] ?? .null, "status": app["status"] ?? .null, "running": app["running"] ?? .null,
                                                 "process_count": app["process_count"] ?? .null, "listeners": listeners, "health": app["health"] ?? .null]]).suffix(4))
            }
        }
        func appState() -> JSONValue {
            with { v in
                let value: JSONValue = ["app": v.currentApp, "app_changes": .array(v.changes)]
                v.changes = []
                return value
            }
        }
    }
}

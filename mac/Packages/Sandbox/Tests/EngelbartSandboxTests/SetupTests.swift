import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/sandbox-local.test.cjs (runLocalSetup) and test/sandbox-provider.test.cjs (readiness before the summary)
final class SetupTests: XCTestCase {
    /// A sandbox with launch.py answering --app-status / --stop / --local, and install-job.py inspecting a plain npm app.
    func sandbox(appRunning: Locked<Bool>, startOutput: String = #"{"phase":"ready","host":"127.0.0.1"}"#) -> (FakeSandbox, Locked<[FakeHandle]>) {
        let box = FakeSandbox()
        box.host = "43110-sb.e2b.app"
        let apps = Locked<[FakeHandle]>([])
        box.runHandler = { command, _ in
            if command.contains("--app-status") {
                return CommandResult(exitCode: 0, stdout: JSONValue.object(["status": appRunning.value ? "healthy" : "idle", "running": .bool(appRunning.value),
                                                                            "processes": [], "listeners": [], "health": ["ok": true],
                                                                            "attempt_id": .null]).text())
            }
            if command.hasSuffix(" inspect") { return CommandResult(exitCode: 0, stdout: InstallTests.facts.text()) }
            return CommandResult(exitCode: 0)
        }
        box.startHandler = { command, options in
            let handle = FakeHandle()
            if command.contains("--local --attempt") {
                apps.with { $0.append(handle) }
                appRunning.with { $0 = true }
                options.onStdout?(startOutput + "\n")
            }
            return handle
        }
        return (box, apps)
    }

    typealias Call = (String, JSONValue?) async throws -> JSONValue

    func run(_ box: FakeSandbox, discovery: JSONValue = ["components": []], agent: @escaping (Call) async throws -> Void,
             events: Locked<[JSONValue]>, readies: Locked<[LocalSetup.Ready]>, signal: AbortSignal? = nil) async throws -> LocalSetup.Ready {
        let call = Locked<Call?>(nil)
        return try await LocalSetup.run(
            sandbox: box, auth: LocalClaudeAuth(file: "claude", env: [:]), environment: SavedEnvironment(values: ["APP_KEY": "secret-value"]),
            model: "claude-sonnet-5-5", signal: signal, onEvent: { e in events.with { $0.append(e) } }, checkPreview: { _ in true },
            onReady: { r in readies.with { $0.append(r) } },
            runAgent: { _, bridge, prompt, model, _, _ in
                XCTAssertTrue(prompt.contains("FIRST, before any install decision, call declare_kind"))
                XCTAssertTrue(prompt.contains("/home/user/repository"))
                XCTAssertEqual(model, "claude-sonnet-5-5")
                XCTAssertEqual(bridge.token, "t")
                try await agent(call.value!)
                return "done"
            },
            discover: { _, _, _, _ in discovery },
            bridgeOpener: { c, _, _ in call.with { $0 = c }; return (ToolBridge.Connection(url: "http://127.0.0.1:1/tools", token: "t"), {}) })
    }

    func testInterfaceNeedsAVerifiedStartAppAndPublishesBeforeTheSummary() async throws {
        let running = Locked(false)
        let (box, apps) = sandbox(appRunning: running)
        let events = Locked<[JSONValue]>([]), readies = Locked<[LocalSetup.Ready]>([])
        let ready = try await run(box, agent: { call in
            await assertThrows(try await call("start_app", ["command": "npm start", "port": 3000]), "Call declare_kind first")
            let declared = try await call("declare_kind", ["kind": "interface", "reason": "A vite app"])
            XCTAssertEqual(declared["next"], "Install dependencies, then start_app.")
            await assertThrows(try await call("start_app", ["command": "npm start", "port": 3000]), "installation is running|has not succeeded")
            _ = try await call("dependency_install", ["action": "stop"])
            _ = try await call("dependency_install", ["action": "skip", "reason": "verified node_modules"])
            let started = try await call("start_app", ["command": "npm run dev", "port": 5173, "path": "/app"])
            XCTAssertEqual(started["ready"], true)
            XCTAssertEqual(started["preview_url"], "https://43110-sb.e2b.app/app")
            XCTAssertEqual(readies.value.count, 1, "readiness is published before the final message")
            await assertThrows(try await call("write_file", ["path": "x", "content": "y"]), "already verified")
        }, events: events, readies: readies)
        XCTAssertEqual(ready.kind, "interface")
        XCTAssertEqual(ready.port, 5173)
        XCTAssertTrue(ready.done === apps.value.first)
        let recipe = try JSONValue.parse(box.files.value["/home/user/.engelbart-canvas/recipe.json"]!)
        XCTAssertEqual(recipe, ["kind": "claude-local", "command": "npm run dev", "cwd": "/home/user/repository", "port": 5173, "path": "/app"])
        XCTAssertTrue(box.commands.value.contains("node /opt/engelbart/proxy.mjs '43110:5173:127.0.0.1'"))
        XCTAssertEqual(box.options.value.first { $0.envs["ENGELBART_CANVAS_APP_ATTEMPT"] != nil } != nil, true)
        XCTAssertTrue(events.value.contains { $0["phase"] == "agent" && $0["status"] == "done" && $0["message"] == "Setup agent finished · preview verified" })
        XCTAssertFalse(JSONValue.array(events.value).text().contains("secret-value"))
    }

    func testTerminalAndBothKinds() async throws {
        let running = Locked(false)
        let (box, _) = sandbox(appRunning: running)
        let events = Locked<[JSONValue]>([]), readies = Locked<[LocalSetup.Ready]>([])
        let terminal = try await run(box, agent: { call in
            _ = try await call("declare_kind", ["kind": "terminal", "reason": "A Python CLI"])
            await assertThrows(try await call("start_app", ["command": "x", "port": 3000]), "declared terminal")
            _ = try await call("dependency_install", ["action": "stop"])
            _ = try await call("dependency_install", ["action": "skip", "reason": "no deps"])
            let r = try await call("terminal_ready", ["cwd": "cli", "hint": "python main.py --help"])
            XCTAssertEqual(r["ready"], true)
        }, events: events, readies: readies)
        XCTAssertEqual(terminal.kind, "terminal")
        XCTAssertEqual(terminal.terminal, ["cwd": "cli", "hint": "python main.py --help"])
        XCTAssertNil(terminal.done)
        XCTAssertTrue(events.value.contains { $0["phase"] == "kind" && $0["message"] == "Used from a terminal: A Python CLI" })
        let both = try await run(sandbox(appRunning: Locked(false)).0, agent: { call in
            _ = try await call("declare_kind", ["kind": "both", "reason": "UI and CLI"])
            _ = try await call("dependency_install", ["action": "stop"])
            _ = try await call("dependency_install", ["action": "skip", "reason": "none"])
            let t = try await call("terminal_ready", ["cwd": ".", "hint": "make"])
            XCTAssertEqual(t["next"], "Terminal ready. Now start the web app with start_app.")
            _ = try await call("start_app", ["command": "npm start", "port": 3000])
        }, events: Locked([]), readies: Locked([]))
        XCTAssertEqual(both.kind, "both")
        XCTAssertNotNil(both.previewURL)
        XCTAssertNotNil(both.terminal)
    }

    func testFinishingWithoutReadinessFailsWithWhatIsMissing() async throws {
        for (calls, expected) in [([] as [(String, JSONValue)], "Claude finished without saying how the repository is used."),
                                  ([("declare_kind", ["kind": "interface", "reason": "web"])], "Claude finished without a verified web preview."),
                                  ([("declare_kind", ["kind": "terminal", "reason": "cli"])], "Claude finished without making the terminal ready.")] {
            let events = Locked<[JSONValue]>([])
            await assertThrows(try await run(sandbox(appRunning: Locked(false)).0, agent: { call in for (n, a) in calls { _ = try await call(n, a) } },
                                             events: events, readies: Locked([])), "^\(NSRegularExpression.escapedPattern(for: expected))$")
            XCTAssertTrue(events.value.contains { $0["phase"] == "agent" && $0["status"] == "failed" })
        }
    }

    func testLateSummaryFailureLeavesTheAppAlone() async throws {
        let (box, apps) = sandbox(appRunning: Locked(false))
        let events = Locked<[JSONValue]>([])
        let ready = try await run(box, agent: { call in
            _ = try await call("declare_kind", ["kind": "interface", "reason": "web"])
            _ = try await call("dependency_install", ["action": "stop"])
            _ = try await call("dependency_install", ["action": "skip", "reason": "none"])
            _ = try await call("start_app", ["command": "npm start", "port": 3000])
            throw SandboxError("max turns")
        }, events: events, readies: Locked([]))
        XCTAssertEqual(ready.kind, "interface")
        XCTAssertFalse(apps.value[0].killed)
        XCTAssertTrue(events.value.contains { $0["status"] == "summary_unavailable" })
    }

    func testDesktopAppsStopBeforeClaude() async throws {
        let events = Locked<[JSONValue]>([])
        await assertThrows(try await run(sandbox(appRunning: Locked(false)).0, discovery: ["components": [["cwd": ".", "hints": ["desktop": ["electron"]]]]],
                                         agent: { _ in XCTFail("Claude never starts") }, events: events, readies: Locked([])),
                           "^Desktop apps are not supported yet: this repository is an Electron app, and a sandbox can show only web previews and terminals\\.$")
        XCTAssertTrue(events.value.contains { $0["phase"] == "kind" && $0["status"] == "unsupported" })
        await assertThrows(try await run(sandbox(appRunning: Locked(false)).0, discovery: ["components": [["cwd": ".", "hints": ["desktop": ["tauri"]]]]],
                                         agent: { _ in }, events: Locked([]), readies: Locked([])), "is a Tauri app")
    }

    func testFailedStartReturnsDiagnosticsAndStopsOwnedProcesses() async throws {
        let running = Locked(false)
        let (box, _) = sandbox(appRunning: running, startOutput: #"{"phase":"error","message":"EADDRINUSE"}"#)
        let events = Locked<[JSONValue]>([])
        _ = try? await run(box, agent: { call in
            _ = try await call("declare_kind", ["kind": "interface", "reason": "web"])
            _ = try await call("dependency_install", ["action": "stop"])
            _ = try await call("dependency_install", ["action": "skip", "reason": "none"])
            do { _ = try await call("start_app", ["command": "npm start", "port": 3000]); XCTFail("expected a failure") } catch {
                let e = error as! SandboxError
                XCTAssertTrue(e.message.hasPrefix("EADDRINUSE"))
                XCTAssertNotNil(e.details["failed_check"])
                XCTAssertNotNil(e.details["app"])
            }
        }, events: events, readies: Locked([]))
        XCTAssertTrue(events.value.contains { $0["phase"] == "setup" && ($0["message"]?.string ?? "").hasPrefix("EADDRINUSE") })
    }

    func testPromptIsTheElectronPromptVerbatim() throws {
        let text = LocalSetupPrompt.text(preflight: ["install": ["status": "running"]], discovery: ["components": []])
        guard let source = SandboxResources.url("launch.py").map({ $0.deletingLastPathComponent() }) else { return }
        _ = source
        XCTAssertTrue(text.hasPrefix("Set up the GitHub repository already cloned at /home/user/repository in the assigned E2B Linux sandbox"))
        XCTAssertTrue(text.contains(#"{"install":{"status":"running"}}"#))
        XCTAssertTrue(text.hasSuffix("but it is not proof of credential-dependent features."))
        // Byte-for-byte against the JS source when the repository is at hand.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../src/main/sandbox/local-setup.cjs").standardized
        if let js = try? String(contentsOf: repo, encoding: .utf8), let start = js.range(of: "prompt: `"), let end = js.range(of: "` }).catch(error") {
            let template = String(js[start.upperBound..<end.lowerBound])
                .replacingOccurrences(of: "${ROOT}", with: "/home/user/repository")
                .replacingOccurrences(of: "${JSON.stringify(preflight)}", with: #"{"install":{"status":"running"}}"#)
                .replacingOccurrences(of: "${JSON.stringify(discovery)}", with: #"{"components":[]}"#)
            XCTAssertEqual(text, template)
        }
    }
}

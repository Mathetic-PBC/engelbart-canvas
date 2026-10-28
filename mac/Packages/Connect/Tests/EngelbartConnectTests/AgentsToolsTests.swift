import XCTest
import EngelbartCore
@testable import EngelbartConnect

final class AgentsToolsTests: XCTestCase {
    func testTransientAndLabels() {
        XCTAssertTrue(AgentKinds.transientFailure(ConnectError("failed", "Selected model is at capacity. Please try a different model.")))
        XCTAssertFalse(AgentKinds.transientFailure(ConnectError("failed", "You hit your usage limit")))
        XCTAssertFalse(AgentKinds.transientFailure(ConnectError("unavailable", "overloaded")))
        XCTAssertEqual(AgentKinds.importToolLabel("import_note_files", ["files": ["a"]]), "Bringing in 1 note")
        XCTAssertEqual(AgentKinds.importToolLabel("browser_open", ["url": "https://www.overleaf.com/project"]), "Opening overleaf.com")
        XCTAssertEqual(AgentKinds.importToolLabel("zzz", [:]), "Working")
        XCTAssertEqual(AgentKinds.updateOf("anthropic", ["type": "assistant", "message": ["content": [["type": "tool_use", "name": "mcp__granola__list_meetings", "input": [:]]]]], { $0 ?? "" }), "Asking granola")
        XCTAssertEqual(AgentKinds.updateOf("openai", ["type": "item.started", "item": ["type": "mcp_tool_call", "server": "engelbart", "tool": "add_note", "arguments": #"{"title":"T"}"#]], { $0 ?? "" }), "Writing “T”")
        XCTAssertEqual(AgentKinds.chromeToolLabel("computer", ["action": "left_click"]), "Clicking")
        XCTAssertEqual(AgentKinds.replLabel(["code": "await tabs.new('https://mail.google.com/x')"]), "Opening mail.google.com in its own tab")
        XCTAssertEqual(CLI.commandLabel("bash -lc 'rg -n foo src'", { $0 ?? "" }), "Searching code for “foo”")
    }

    func testConfigs() {
        let connectors = [ConnectorServer(app: "Granola", name: "granola", url: "https://mcp.granola.ai/mcp", token: "t"), ConnectorServer(app: "Linear", name: "linear", url: "https://mcp.linear.app/mcp", type: "http", own: true)]
        let toml = AgentKinds.importConfig(server: ("/app/Engelbart", ["--mcp", "import", "/c.json"], [:]), connectors: connectors, kind: "survey")
        XCTAssertTrue(toml.contains("[mcp_servers.granola]\nurl = \"https://mcp.granola.ai/mcp\"\nbearer_token_env_var = \"ENGELBART_CONNECTOR_GRANOLA\""))
        XCTAssertTrue(toml.contains("enabled_tools = [\"list_meetings\", \"list_meeting_folders\", \"get_account_info\"]"))
        XCTAssertFalse(toml.contains("[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nbearer"))
        XCTAssertTrue(toml.contains("browser_use = false"))
        let servers = AgentKinds.claudeServers(connection: "/c.json", connectors: connectors, kind: "import")
        XCTAssertEqual(servers["mcpServers"]?["granola"]?["headers"]?["Authorization"]?.string, "Bearer t")
        XCTAssertNil(servers["mcpServers"]?["linear"]?["headers"])
        XCTAssertEqual(servers["mcpServers"]?["engelbart"]?["args"]?[1]?.string, "import")
        XCTAssertEqual(AgentKinds.claudeToolsFor("redact").tools, "")
        XCTAssertEqual(AgentKinds.claudeToolsFor("interview").allowed, "Read,Grep,Glob")
        XCTAssertTrue(AgentKinds.claudeToolsFor("import", connectors: connectors).allowed.contains("mcp__engelbart__*,mcp__granola__list_meetings"))
        XCTAssertEqual(AgentKinds.tomlValue(["b": 1, "a": ["x"]]), "{ a = [\"x\"], b = 1 }")
        let home = TempDir()
        home.write("models_cache.json", #"{"models":[{"slug":"gpt-7-sol","visibility":"list"},{"slug":"gpt-6.1-luna","visibility":"list"}]}"#)
        XCTAssertEqual(AgentKinds.codexModel("gpt-6.1-sol", home: home.path), "gpt-7-sol")
        XCTAssertEqual(AgentKinds.codexModel("gpt-6.1-sol", home: "/nowhere"), "gpt-6.1-sol")
        home.write("config.toml", "[features]\nbrowser_use = false\n[plugins.\"chrome@openai-bundled\"]\nenabled = true\n[plugins.\"slack@x\"]\nenabled = true\n[mcp_servers.node_repl]\ncommand = \"x\"\n[mcp_servers.\"granola\"]\nurl = \"u\"\n")
        XCTAssertEqual(AgentKinds.codexServersOff(home.path), ["granola"])
        XCTAssertEqual(AgentKinds.codexPluginsOff(home.path), ["slack@x"])
        XCTAssertEqual(BrowserAgents.readCodexConfig("features.browser_use = false").features["browser_use"], false)
    }

    func testCLIEnvironment() {
        let env = CLI.sanitizeEnvironment(CLI.scrubAgentSession(["PATH": "/bin", "CLAUDECODE": "1", "ELECTRON_RUN_AS_NODE": "1", "CLAUDE_CODE_SESSION_ID": "x", "CLAUDE_PID": "2", "HOME": "/h"]))
        XCTAssertNil(env["CLAUDECODE"]); XCTAssertNil(env["ELECTRON_RUN_AS_NODE"]); XCTAssertNil(env["CLAUDE_PID"])
        XCTAssertEqual(env["TERM_PROGRAM"], "Engelbart")
        XCTAssertEqual(CLI.loginShellArgs("/bin/zsh", "echo", ["ENGELBART_GIT_BIN": "/g"]), ["-ilc", "PATH=\"$ENGELBART_GIT_BIN:$PATH\"; echo"])
        XCTAssertEqual(CLI.loginShellArgs("/usr/local/bin/fish", "echo", [:]).first, "--login")
        XCTAssertEqual(CLI.lastResultLine("noise\n{\"type\":\"result\",\"result\":\"ok\"}\n{\"type\":\"x\"}")?["result"]?.string, "ok")
        let home = TempDir()
        let auth = home.write("auth.json", #"{"auth_mode":"chatgpt","tokens":{"id_token":"x"}}"#)
        XCTAssertTrue(CLI.prepareCodexHome(codexHome: home.url.appendingPathComponent("h").path, source: auth, instructions: "be good"))
        XCTAssertEqual(try? String(contentsOfFile: home.url.appendingPathComponent("h/AGENTS.md").path, encoding: .utf8), "be good")
        XCTAssertFalse(CLI.prepareCodexHome(codexHome: home.url.appendingPathComponent("k").path, source: home.write("key.json", #"{"auth_mode":"apikey"}"#), instructions: ""))
    }

    func testRetryRunsTheTurnAgain() async throws {
        final class Flaky: ConnectAgents, @unchecked Sendable { var n = 0; func turn(_ i: AgentTurnInput) async throws -> AgentTurnOutput { n += 1; if n < 2 { throw ConnectError("failed", "overloaded_error 529") }; return AgentTurnOutput(text: "ok", session: nil) } }
        // CLIAgents' retry loop is exercised through a tool manager that runs the fake instead of the CLI.
        final class Manager: ConnectToolManager, @unchecked Sendable {
            let flaky = Flaky()
            func binaryFor(_ name: String) -> String? { nil }
            func environment() -> [String: String] { [:] }
            func ensure(_ cli: String) async throws {}
            func use<T>(_ cli: String, _ work: () async throws -> T) async throws -> T { try await flaky.turn(AgentTurnInput(choice: ConnectModels.choice("anthropic", models: nil), kind: "import", system: "", message: "", meta: AgentMeta(kind: "import"))) as! T }
            func check(_ clis: [String]) async {}
        }
        let dir = TempDir()
        var updates: [String] = []
        let agents = CLIAgents(runDirectory: dir.path, interviewHome: dir.path, tools: Manager(), retryWaits: [0, 0], sleep: { _, _ in })
        let out = try await agents.turn(AgentTurnInput(choice: ConnectModels.choice("anthropic", models: nil), kind: "import", system: "s", message: "m", onUpdate: { if let a = $0.activity { updates.append(a) } }, meta: AgentMeta(kind: "import")))
        XCTAssertEqual(out.text, "ok")
        XCTAssertEqual(updates, ["The model is busy: trying again"])
    }

    func testToolsCatalog() throws {
        XCTAssertEqual(Tools.definitions.count, 42)
        XCTAssertFalse(Tools.toolsForKind["import"]!.contains("save_memory"))
        XCTAssertEqual(Tools.toolNamesFor("import", apps: ["ChatGPT"]).filter { $0.hasPrefix("browser_") && Tools.browsing.contains($0) }, [])
        XCTAssertTrue(Tools.toolNamesFor("import", apps: ["Google Docs"]).contains("browser_open"))
        XCTAssertFalse(Tools.toolNamesFor("import", apps: ["Google Docs"], approvals: true).contains("browser_open"))
        XCTAssertTrue(Tools.toolNamesFor("recall", apps: ["ChatGPT"]).contains("browser_type"))
        XCTAssertEqual(Tools.browseSitesFor("survey", apps: ["Google Docs"]), ["drive.google.com"])
        XCTAssertThrowsError(try Tools.validate("add_note", ["title": "t"]))
        XCTAssertThrowsError(try Tools.validate("add_note", ["title": "t", "markdown": "m", "extra": 1]))
        XCTAssertThrowsError(try Tools.validate("list_chats", ["app": 3]))
        XCTAssertNoThrow(try Tools.validate("add_note", ["title": "t", "markdown": .string(String(repeating: "x", count: 10_000))]))
        XCTAssertThrowsError(try Tools.validate("add_note", ["title": .string(String(repeating: "x", count: 5000)), "markdown": "m"]))
        XCTAssertEqual(Tools.csvTable("a,\"b,c\"\n1,2\n"), "| a | b,c |\n| --- | --- |\n| 1 | 2 |")
        XCTAssertTrue(Tools.chatNote("Codex", title: "t", date: "2026-10-01T00:00:00Z", project: "~/x", turns: [Readers.Turn(role: "user", text: "q"), Readers.Turn(role: "assistant", text: "a")]).hasPrefix("*Codex · 2026-10-01 · ~/x*\n\n**You:** q\n\n**Codex:** a"))
        XCTAssertEqual(Tools.toolsFor("survey", only: ["needs_you"]).count, 1)
    }

    func testImportToolsWriteNotesOnce() async throws {
        let home = TempDir()
        let root = TempDir()
        home.write("Vault/a.md", "Hello [[b]]")
        home.write("Vault/b.md", "B")
        home.mkdir("Desktop")
        let store = FakeStore(root: root.path)
        var added = 0
        let session = ToolSession(dataRoot: root.path, homeDir: home.path, dir: root.path, downloads: root.url.appendingPathComponent("dl").path,
                                  readable: { !$0.hasPrefix(home.url.appendingPathComponent("Desktop").path) }, apps: ["Obsidian"], group: "notes")
        let tools = ImportTools(session: session, store: store, kind: "import", added: { _, n, _ in added += n })
        let out = try await tools.call("import_note_files", ["files": [.string(home.url.appendingPathComponent("Vault/a.md").path), "~/Vault/b.md", "/etc/hosts"], "root": .string(home.url.appendingPathComponent("Vault").path)]) as! JSONValue
        XCTAssertEqual(out["added"]?.int, 2)
        XCTAssertEqual(out["skippedCount"]?.int, 1)
        XCTAssertTrue(store.added.contains { $0.text.contains("@[b]") })
        XCTAssertEqual(store.added.first?.about?["source"]?.string, "Obsidian")
        let again = try await tools.call("import_note_files", ["files": [.string(home.url.appendingPathComponent("Vault/a.md").path)]]) as! JSONValue
        XCTAssertEqual(again["skipped"]?[0]?["why"]?.string, "brought in before")
        do { _ = try await tools.call("folder_overview", ["path": "~/Desktop"]); XCTFail() } catch { XCTAssertTrue((error as? ConnectError)?.message.hasPrefix("macOS has not let Engelbart read ~/Desktop") == true) }
        let survey = ImportTools(session: session, store: store, kind: "survey")
        do { _ = try await survey.call("add_note", ["title": "t", "markdown": "m"]); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "A survey brings nothing in: report what you found instead.") }
        let note = try await tools.call("add_note", ["title": "Meeting", "markdown": "notes", "source": "granola:1"]) as! JSONValue
        XCTAssertEqual(note["added"], true)
        let dup = try await tools.call("add_note", ["title": "Meeting", "markdown": "notes", "source": "granola:1"]) as! JSONValue
        XCTAssertEqual(dup["why"]?.string, "brought in before")
        let none = try await tools.call("wait_for_you", .object([:])) as! JSONValue
        XCTAssertEqual(none["note"]?.string, "Nothing is waiting on the person.")
        do { _ = try await tools.call("browser_read", .object([:])); XCTFail() } catch { XCTAssertEqual((error as? ConnectError)?.message, "Engelbart's browser is not available to this agent. Say so in your reply.") }
    }

    func testBrowserRules() {
        XCTAssertTrue(AgentBrowser.hostAllowed("https://docs.google.com/x", ["google.com"]))
        XCTAssertFalse(AgentBrowser.hostAllowed("http://docs.google.com/x", ["google.com"]))
        XCTAssertTrue(AgentBrowser.hostAllowed("http://127.0.0.1:3000/", ["127.0.0.1"]))
        XCTAssertFalse(AgentBrowser.hostAllowed("https://evilgoogle.com", ["google.com"]))
        XCTAssertTrue(AgentBrowser.hostsFor(["chatgpt.com"]).contains("auth.openai.com"))
        XCTAssertTrue(AgentBrowser.signsOut("https://x.com/logout?next=/"))
        var del = AgentBrowser.Info(); del.tag = "button"; del.name = "Delete file"
        XCTAssertEqual(AgentBrowser.clickRefusal(del), "“Delete file” could change something in the account")
        var open = AgentBrowser.Info(); open.tag = "a"; open.href = "https://x.org/doc"; open.name = "Open doc"
        XCTAssertNil(AgentBrowser.clickRefusal(open))
        var box = AgentBrowser.Info(); box.tag = "input"; box.type = "text"; box.name = "Search mail"; box.search = true
        XCTAssertNil(AgentBrowser.typeRefusal(box))
        XCTAssertNil(AgentBrowser.pressRefusal("Enter", box))
        var composer = AgentBrowser.Info(); composer.editable = true
        XCTAssertNotNil(AgentBrowser.typeRefusal(composer))
        XCTAssertEqual(AgentBrowser.pressRefusal("Backspace", nil), "Backspace could delete something: it is only pressed in a search box")
        var pw = AgentBrowser.Info(); pw.tag = "input"; pw.type = "password"
        XCTAssertEqual(AgentBrowser.typeRefusal(pw), "That is a password field: call needs_you so the person signs in themselves")
        XCTAssertEqual(AgentBrowser.fileNameOf(disposition: "attachment; filename*=UTF-8''My%20Doc.pdf", url: "https://x/y"), "My Doc.pdf")
        XCTAssertEqual(AgentBrowser.fileNameOf(disposition: "", url: "https://x/a/report.zip"), "report.zip")
        let dir = TempDir()
        dir.write("a.pdf", "x")
        XCTAssertEqual((try? AgentBrowser.freePath(dir.path, "a.pdf")).map { ($0 as NSString).lastPathComponent }, "a-2.pdf")
        XCTAssertTrue(AgentBrowser.readScript(offset: 10, max: 500).contains("text.slice(10, 510)"))
        XCTAssertTrue(AgentBrowser.typeScript("e1", "hi \"there\"", replace: true).contains(#"const text = "hi \"there\"";"#))
    }

    func testImportMCP() async {
        let tools = Tools.toolsFor("survey")
        let target = URL(string: "http://127.0.0.1:9/tools")!
        let list = await ImportMCP.handle(["jsonrpc": "2.0", "id": 1, "method": "tools/list"], tools: tools, target: target, token: "t")
        XCTAssertEqual(list?["result"]?["tools"]?.array?.count, tools.count)
        let call = await ImportMCP.handle(["jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": ["name": "x", "arguments": [:]]], tools: tools, target: target, token: "t",
                                          post: { req in
                                              XCTAssertEqual(req.value(forHTTPHeaderField: "authorization"), "Bearer t")
                                              return (Data(#"{"content":[{"type":"image","data":"AA","mimeType":"image/jpeg"}]}"#.utf8), 200)
                                          })
        XCTAssertEqual(call?["result"]?["content"]?[0]?["type"]?.string, "image")
        let note = await ImportMCP.handle(["jsonrpc": "2.0", "method": "notifications/initialized"], tools: tools, target: target, token: "t")
        XCTAssertNil(note)
    }

    func testToolBridge() async throws {
        let bridge = try await ToolBridge.open({ name, args in ["got": .string(name), "n": args["n"] ?? .null] as JSONValue })
        defer { bridge.close() }
        XCTAssertTrue(bridge.connection.url.hasPrefix("http://127.0.0.1:"))
        XCTAssertTrue(JS.test(bridge.connection.token, "^[a-f0-9]{64}$"))
        var req = URLRequest(url: URL(string: bridge.connection.url)!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(bridge.connection.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = Data(#"{"name":"list_chats","args":{"n":3}}"#.utf8)
        let (data, response) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let body = try JSONValue.parse(data)
        XCTAssertEqual(try JSONValue.parse(JS.string(body["content"]?[0]?["text"]))["got"]?.string, "list_chats")
        req.setValue("Bearer wrong", forHTTPHeaderField: "Authorization")
        let (_, refused) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((refused as? HTTPURLResponse)?.statusCode, 403)
    }
}
